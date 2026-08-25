import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCESS_KEY_LENGTH,
  accessKeyRaw,
  filterEpisodesByAccess,
  formatAccessKey,
  hashAccessKey,
  isValidAccessKey,
  readAccessToken,
  storeAccessToken,
} from "./accessKey.js";
import { MarkdownBody } from "./MarkdownBody.jsx";
import { validateAudioFile } from "./media.js";
import {
  EPISODE_REFRESH_INTERVAL_MS,
  changeAdminPin,
  getAdminSession,
  getStorageStatus,
  loadEpisodeDetails as loadSupabaseEpisodeDetails,
  migrateEpisodeStorage,
  removeEpisode as removeSupabaseEpisode,
  renumberEpisodes as renumberSupabaseEpisodes,
  saveEpisode as saveSupabaseEpisode,
  saveStorageSettings,
  signInAdmin,
  signOutAdmin,
  setupR2,
  toggleR2,
  watchAdminSession,
  watchEpisodes,
} from "./supabase.js";

const BOOKMARKS_KEY = "tba-bookmarks-v1";
const R2_INCLUDED_BYTES = 10_000_000_000;
const MAX_SUPABASE_FILE_BYTES = 50_000_000;
const SHOWCASE_CACHE_KEY = "tba-showcase-cache-v1";
const MarkdownEditor = lazy(() => import("./MarkdownEditor.jsx").then((module) => ({ default: module.MarkdownEditor })));
const FORMAT_OPTIONS = [
  { value: "Tous", label: "Tous" },
  { value: "Vidéo", label: "Vidéo" },
  { value: "Vocal", label: "Audio" },
  { value: "Texte", label: "Texte" },
];
const EPISODE_FORMAT_OPTIONS = FORMAT_OPTIONS.filter(({ value }) => value !== "Tous");
const MONTH_NAMES = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const WEEK_DAYS = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];

const icons = {
  home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 8h.01"/></>,
  play: <path d="m9 7 8 5-8 5Z"/>,
  pause: <><path d="M9 7v10M15 7v10"/></>,
  text: <><path d="M5 6h14M5 11h14M5 16h9M5 20h7"/></>,
  wave: <><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4"/></>,
  arrow: <><path d="M4 12h16"/><path d="m15 7 5 5-5 5"/></>,
  back: <><path d="M20 12H4"/><path d="m9 17-5-5 5-5"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  filter: <><path d="M4 6h16M7 12h10M10 18h4"/></>,
  upload: <><path d="m12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8.5A7 7 0 0 1 18.4 6L20 12M4 12l1.6 6A7 7 0 0 0 17.9 15.5"/></>,
  bookmark: <path d="M6 4h12v16l-6-4-6 4Z"/>,
  bookmarkFilled: <path d="M6 4h12v16l-6-4-6 4Z" fill="currentColor" stroke="none"/>,
  chevron: <path d="m7 10 5 5 5-5"/>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
};

function Icon({ name, size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>;
}

function displayDate(date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`));
}

function typeIcon(type) {
  return type === "Vidéo" ? "play" : type === "Vocal" ? "wave" : "text";
}

function displayType(type) {
  return type === "Vocal" ? "Audio" : type;
}

function youtubeId(url = "") {
  const value = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^(?:www\.|m\.)/, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const queryId = parsed.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{11}$/.test(queryId)) return queryId;
      const pathMatch = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
      return pathMatch?.[1] || "";
    }
  } catch {
    return "";
  }
  return "";
}

function makeNumber(episodes) {
  return episodes.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0) + 1;
}

function formatEpisodeNumber(number) {
  return String(number || 0).padStart(3, "0");
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function toShowcaseEpisode(episode) {
  return {
    uid: episode.uid,
    id: episode.id,
    number: episode.number,
    title: episode.title,
    description: episode.description,
    type: episode.type,
    tags: episode.tags,
    date: episode.date,
    duration: episode.duration,
    image: episode.image,
    youtube: episode.youtube,
    audio: episode.audio,
    palette: episode.palette,
    createdAt: episode.createdAt,
    cached: true,
  };
}

function readShowcaseCache(accessToken = "") {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOWCASE_CACHE_KEY));
    if (!saved || ![1, 2, 3].includes(saved.version) || !Array.isArray(saved.episodes)) {
      if (!saved
        || saved.version !== 4
        || saved.accessToken !== accessToken
        || !Array.isArray(saved.episodes)) {
        return { episodes: [], savedAt: 0 };
      }
    }
    if (saved.version !== 4 && accessToken) return { episodes: [], savedAt: 0 };
    return {
      savedAt: [3, 4].includes(saved.version) && Number.isFinite(saved.savedAt) ? saved.savedAt : 0,
      episodes: saved.episodes.filter((episode) => episode
      && typeof episode.id === "string"
      && typeof episode.title === "string"
      && Array.isArray(episode.tags)),
    };
  } catch {
    return { episodes: [], savedAt: 0 };
  }
}

function isShowcaseCacheFresh(cache) {
  return cache.episodes.length > 0
    && cache.savedAt > 0
    && Date.now() - cache.savedAt < EPISODE_REFRESH_INTERVAL_MS;
}

function writeShowcaseCache(episodes, accessToken = "") {
  const cache = {
    savedAt: Date.now(),
    episodes: episodes.map(toShowcaseEpisode),
  };
  try {
    localStorage.setItem(SHOWCASE_CACHE_KEY, JSON.stringify({
      version: 4,
      accessToken,
      ...cache,
    }));
  } catch {
    // Le cache vitrine ne doit jamais bloquer les données Supabase fraîches.
  }
  return cache;
}

function makeShortId() {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function makeUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function readRoute() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const episodeMatch = path.match(/^\/tba\/([^/]+)$/);
  if (episodeMatch) {
    return { view: "episode", episodeId: decodeURIComponent(episodeMatch[1]), tag: "" };
  }
  if (path === "/listes") {
    return { view: "archive", episodeId: "", tag: new URLSearchParams(window.location.search).get("sujet") || "" };
  }
  if (path === "/signets") return { view: "bookmarks", episodeId: "", tag: "" };
  if (path === "/informations") return { view: "about", episodeId: "", tag: "" };
  return { view: "home", episodeId: "", tag: "" };
}

function routeUrl(view, episodeId = "", tag = "") {
  if (view === "episode") return `/tba/${encodeURIComponent(episodeId)}`;
  if (view === "archive") return tag ? `/listes?sujet=${encodeURIComponent(tag)}` : "/listes";
  if (view === "bookmarks") return "/signets";
  if (view === "about") return "/informations";
  return "/";
}

function Poster({ episode, large = false }) {
  return (
    <div className={`poster palette-${episode.palette % 6} ${large ? "poster-large" : ""}`} style={episode.image ? { backgroundImage: `url(${episode.image})` } : undefined}>
      {!episode.image && <><div className="poster-grid"/><i className="orbit orbit-a"/><i className="orbit orbit-b"/></>}
      <span className="poster-code">{formatEpisodeNumber(episode.number)}</span>
      <span className="poster-word">BIZARRE</span>
    </div>
  );
}

function Tags({ tags, onTag, interactive = true }) {
  return <div className="tags">{tags.map((tag) => interactive
    ? <button type="button" key={tag} onClick={(event) => { event.stopPropagation(); onTag?.(tag); }}>#{tag}</button>
    : <span key={tag}>#{tag}</span>)}</div>;
}

function BookmarkButton({ active, onToggle, className = "" }) {
  return <button type="button" className={`bookmark-button ${active ? "active" : ""} ${className}`.trim()} onClick={(event) => { event.stopPropagation(); onToggle(); }} aria-pressed={active} aria-label={active ? "Retirer des signets" : "Ajouter aux signets"}><Icon name={active ? "bookmarkFilled" : "bookmark"} size={17}/></button>;
}

function EpisodeCard({ episode, onOpen, onTag, preview = false, bookmarked = false, onToggleBookmark }) {
  const visual = <><Poster episode={episode}/><span className="format"><Icon name={typeIcon(episode.type)} size={14}/>{displayType(episode.type)}</span></>;
  return (
    <article className={`episode-card ${preview ? "is-preview" : ""}`}>
      <div className="card-visual">
        {preview ? <div className="poster-button">{visual}</div> : <button type="button" className="poster-button" onClick={() => onOpen(episode)}>{visual}</button>}
        {!preview && <BookmarkButton active={bookmarked} onToggle={() => onToggleBookmark(episode.id)}/>}
      </div>
      <div className="card-copy">
        <div className="topline"><span>TBA — {formatEpisodeNumber(episode.number)}</span><span>{displayDate(episode.date)} · {episode.duration}</span></div>
        <h2>{preview ? episode.title : <button type="button" onClick={() => onOpen(episode)}>{episode.title}</button>}</h2>
        <p>{episode.description}</p>
        <Tags tags={episode.tags} onTag={onTag} interactive={!preview}/>
        {!preview && <button type="button" className="text-link" onClick={() => onOpen(episode)}>Voir le TBA <Icon name="arrow" size={17}/></button>}
      </div>
    </article>
  );
}

function Home({ episode, onOpen, onTag, bookmarks, onToggleBookmark }) {
  if (!episode) return <Empty title="Aucun épisode" text="Crée le premier TBA depuis l’espace admin."/>;
  return (
    <section className="home">
      <header className="home-heading">
        <p className="new"><i/> Nouveau TBA</p>
      </header>
      <EpisodeCard episode={episode} onOpen={onOpen} onTag={onTag} bookmarked={bookmarks.has(episode.id)} onToggleBookmark={onToggleBookmark}/>
    </section>
  );
}

function TopicFilter({ tags, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const matches = tags.filter((tag) => tag.includes(search.trim().toLowerCase()));
  return (
    <div className="topic-filter">
      <button className={`topic-trigger ${value ? "active" : ""}`} type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <Icon name="filter"/>
        <span>{value ? `#${value}` : "Sujets"}</span>
        <small>{tags.length}</small>
      </button>
      {open && <div className="topic-menu">
        <div className="topic-menu-heading"><div><strong>Filtrer par sujet</strong><span>{tags.length} hashtags détectés</span></div><button type="button" onClick={() => setOpen(false)} aria-label="Fermer"><Icon name="close" size={17}/></button></div>
        {tags.length > 6 && <label className="topic-search"><Icon name="search" size={17}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Chercher un hashtag…"/></label>}
        <div className="topic-options">
          <button className={!value ? "selected" : ""} type="button" onClick={() => { onChange(""); setOpen(false); }}>Tous les sujets</button>
          {matches.map((tag) => <button className={value === tag ? "selected" : ""} type="button" key={tag} onClick={() => { onChange(tag); setOpen(false); }}>#{tag}</button>)}
          {!matches.length && <p>Aucun sujet trouvé.</p>}
        </div>
      </div>}
    </div>
  );
}

function FormatFilter({ value, onChange, options = FORMAT_OPTIONS }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const closeWithKeyboard = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [open]);
  return (
    <div className="format-filter" ref={root}>
      <button className={`format-trigger ${value !== "Tous" ? "active" : ""}`} type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="true">
        <Icon name="filter"/>
        <span>{displayType(value)}</span>
        <Icon name="chevron" size={16}/>
      </button>
      {open && <div className="format-menu">
        {options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" key={option.value} onClick={() => { onChange(option.value); setOpen(false); }} aria-pressed={value === option.value}>
          <Icon name={option.value === "Tous" ? "filter" : typeIcon(option.value)} size={16}/>
          <span>{option.label}</span>
        </button>)}
      </div>}
    </div>
  );
}

function parseDateValue(value) {
  const [year, month, day] = value.split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : new Date();
}

function toDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function DatePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => parseDateValue(value));
  const root = useRef(null);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateValue(new Date());

  useEffect(() => {
    if (!open) return undefined;
    setCursor(parseDateValue(value));
    const closeOutside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const closeWithKeyboard = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [open, value]);

  const choose = (day) => {
    onChange(toDateValue(new Date(year, month, day)));
    setOpen(false);
  };

  return (
    <div className="date-picker" ref={root}>
      <button className={`date-trigger ${open ? "active" : ""}`} type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="dialog">
        <Icon name="calendar"/>
        <span>{displayDate(value)}</span>
        <Icon name="chevron" size={16}/>
      </button>
      {open && <div className="date-menu" role="dialog" aria-label="Choisir une date">
        <div className="date-menu-heading">
          <button type="button" className="previous" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Mois précédent"><Icon name="chevron" size={17}/></button>
          <strong>{MONTH_NAMES[month]} {year}</strong>
          <button type="button" className="next" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Mois suivant"><Icon name="chevron" size={17}/></button>
        </div>
        <div className="date-weekdays" aria-hidden="true">
          {WEEK_DAYS.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="date-days">
          {Array.from({ length: offset }, (_, index) => <i key={`empty-${index}`}/>)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const dayValue = toDateValue(new Date(year, month, day));
            return <button
              type="button"
              key={dayValue}
              className={`${dayValue === value ? "selected" : ""} ${dayValue === todayValue ? "today" : ""}`.trim()}
              onClick={() => choose(day)}
              aria-label={displayDate(dayValue)}
              aria-pressed={dayValue === value}
            >{day}</button>;
          })}
        </div>
        <button type="button" className="date-today" onClick={() => { onChange(todayValue); setOpen(false); }}>Aujourd’hui</button>
      </div>}
    </div>
  );
}

function Archive({ episodes, allTags, tag, setTag, onOpen, bookmarks, onToggleBookmark }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("Tous");
  const visible = episodes.filter((item) => {
    const haystack = `${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (type === "Tous" || item.type === type) && (!tag || item.tags.includes(tag));
  });
  return (
    <section>
      <header className="page-heading">
        <div><p className="eyebrow">L’archive</p></div>
        <p>toutes les archives textuelles, vidéo et audio référencées</p>
      </header>
      <div className="filters">
        <label className="search-field"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un épisode…"/></label>
        <FormatFilter value={type} onChange={setType}/>
        <TopicFilter tags={allTags} value={tag} onChange={setTag}/>
      </div>
      {tag && <div className="active-topic"><span>Filtre actif : #{tag}</span><button onClick={() => setTag("")}>Effacer</button></div>}
      {visible.length ? <div className="episode-grid">{visible.map((episode) => <EpisodeCard key={episode.id} episode={episode} onOpen={onOpen} onTag={setTag} bookmarked={bookmarks.has(episode.id)} onToggleBookmark={onToggleBookmark}/>)}</div> : <Empty title="Rien ici" text="Change recherche ou filtres."/ >}
    </section>
  );
}

function AudioPlayer({ src }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [audioError, setAudioError] = useState("");
  const toggle = async () => {
    if (!audio.current) return;
    if (playing) audio.current.pause();
    else {
      try {
        setAudioError("");
        await audio.current.play();
      } catch {
        setAudioError("Ce fichier audio n’est pas compatible avec ce navigateur. Réencode-le en MP3, AAC ou M4A AAC.");
      }
    }
  };
  const changeRate = (nextRate) => {
    setRate(nextRate);
    if (audio.current) audio.current.playbackRate = nextRate;
  };
  const syncAudioTime = (element) => {
    const total = Number.isFinite(element.duration) ? element.duration : 0;
    setCurrentTime(element.currentTime || 0);
    setDuration(total);
    setProgress(total ? (element.currentTime / total) * 100 : 0);
  };
  return (
    <div className="audio-block">
      <div className="audio-player">
        <audio ref={audio} src={src} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setAudioError("Ce fichier audio n’est pas compatible avec ce navigateur. Réencode-le en MP3, AAC ou M4A AAC.")} onEnded={(event) => { setPlaying(false); syncAudioTime(event.currentTarget); }} onLoadedMetadata={(event) => syncAudioTime(event.currentTarget)} onDurationChange={(event) => syncAudioTime(event.currentTarget)} onTimeUpdate={(event) => syncAudioTime(event.currentTarget)}/>
        <button onClick={toggle} aria-label={playing ? "Pause" : "Lecture"}><Icon name={playing ? "pause" : "play"}/></button>
        <div className="audio-line" onClick={(event) => { if (!audio.current || !Number.isFinite(audio.current.duration)) return; const rect = event.currentTarget.getBoundingClientRect(); audio.current.currentTime = ((event.clientX - rect.left) / rect.width) * audio.current.duration; syncAudioTime(audio.current); }}><i style={{ width: `${progress}%` }}/></div>
        <span className="audio-time">{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</span>
      </div>
      {audioError && <p className="form-error" role="alert">{audioError}</p>}
      <div className="audio-speeds" aria-label="Vitesse de lecture">
        {[1, 1.5, 2].map((speed) => <button type="button" className={rate === speed ? "active" : ""} onClick={() => changeRate(speed)} aria-pressed={rate === speed} key={speed}>x{String(speed).replace(".", ",")}</button>)}
      </div>
    </div>
  );
}

function EpisodePage({ episode, onBack, onTag, bookmarked, onToggleBookmark }) {
  const video = youtubeId(episode.youtube);
  const hasBody = Boolean(episode.body?.trim());
  const hasContent = Boolean(video || episode.audio || hasBody);
  return (
    <article className="episode-page">
      <button className="back" onClick={onBack}><Icon name="back"/> Retour</button>
      <div className="episode-hero"><div className="episode-visual"><Poster episode={episode} large/><BookmarkButton active={bookmarked} onToggle={() => onToggleBookmark(episode.id)}/></div><div>
        <p className="eyebrow">TBA — {formatEpisodeNumber(episode.number)}</p>
        <h1>{episode.title}</h1>
        <p className="lead">{episode.description}</p>
        <div className="metadata"><span>{displayType(episode.type)}</span><span>{episode.duration}</span><span>{displayDate(episode.date)}</span></div>
        <Tags tags={episode.tags} onTag={onTag}/>
      </div></div>
      {hasContent && <div className="episode-body">
        <div className="content-divider" aria-hidden="true"><span>Contenu</span><i/></div>
        {video && <div className="video"><iframe src={`https://www.youtube-nocookie.com/embed/${video}`} title={episode.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen/></div>}
        {episode.audio && <AudioPlayer src={episode.audio}/>}
        {hasBody && <div className="prose"><MarkdownBody>{episode.body}</MarkdownBody></div>}
      </div>}
    </article>
  );
}

function BookmarksPage({ episodes, onOpen, onTag, bookmarks, onToggleBookmark }) {
  return <section className="bookmarks-page">
    <header className="page-heading"><div><p className="eyebrow">Votre sélection</p><h1>Signets</h1></div><p>Les TBA sauvegardés dans ce navigateur.</p></header>
    {episodes.length ? <div className="episode-grid">{episodes.map((episode) => <EpisodeCard key={episode.id} episode={episode} onOpen={onOpen} onTag={onTag} bookmarked={bookmarks.has(episode.id)} onToggleBookmark={onToggleBookmark}/>)}</div> : <Empty title="Aucun signet" text="Utilise icône marque-page sur un TBA pour le retrouver ici."/>}
  </section>;
}

function accessKeyCaret(rawIndex) {
  return rawIndex
    + (rawIndex >= 3 ? 1 : 0)
    + (rawIndex >= 7 ? 1 : 0);
}

function AccessKeyInput({
  value,
  onChange,
  disabled = false,
  placeholder = "TBA-ABC1-23",
  ariaLabel = "Clé d’accès",
  onEnter,
  className = "",
}) {
  const input = useRef(null);

  const placeCaret = (rawIndex) => {
    window.requestAnimationFrame(() => {
      const position = accessKeyCaret(rawIndex);
      input.current?.setSelectionRange(position, position);
    });
  };

  const handleChange = (event) => {
    const rawIndex = accessKeyRaw(
      event.currentTarget.value.slice(0, event.currentTarget.selectionStart ?? undefined),
    ).length;
    const next = formatAccessKey(event.currentTarget.value);
    onChange(next);
    placeCaret(Math.min(rawIndex, accessKeyRaw(next).length));
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onEnter?.();
      return;
    }
    if (event.key !== "Backspace") return;

    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    if (start !== end || !start || event.currentTarget.value[start - 1] !== "-") return;

    event.preventDefault();
    const raw = accessKeyRaw(event.currentTarget.value);
    const rawIndex = accessKeyRaw(event.currentTarget.value.slice(0, start)).length;
    onChange(formatAccessKey(raw.slice(0, rawIndex - 1) + raw.slice(rawIndex)));
    placeCaret(rawIndex - 1);
  };

  return <input
    ref={input}
    className={className}
    type="text"
    inputMode="text"
    maxLength="11"
    autoCapitalize="characters"
    autoComplete="off"
    autoCorrect="off"
    spellCheck="false"
    value={value}
    onChange={handleChange}
    onKeyDown={handleKeyDown}
    disabled={disabled}
    placeholder={placeholder}
    aria-label={ariaLabel}
  />;
}

function AccessKeyModule({ accessToken, onAccessTokenChange }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const rawLength = accessKeyRaw(value).length;
  const complete = isValidAccessKey(value);
  const loaded = Boolean(accessToken);

  const submit = async () => {
    if (busy) return;
    if (loaded) {
      storeAccessToken("");
      setValue("");
      onAccessTokenChange("");
      return;
    }
    if (!complete) return;

    try {
      setBusy(true);
      const token = await hashAccessKey(value);
      storeAccessToken(token);
      setValue("");
      onAccessTokenChange(token);
    } finally {
      setBusy(false);
    }
  };

  return <div className={`access-key-module ${loaded ? "is-loaded" : ""}`}>
    <AccessKeyInput
      value={value}
      onChange={setValue}
      disabled={loaded || busy}
      placeholder={loaded ? "CLÉ CHARGÉE" : "TBA-ABC1-23"}
      ariaLabel={loaded ? "Une clé d’accès est chargée" : "Charger une clé d’accès"}
      onEnter={submit}
      className={complete ? "is-complete" : ""}
    />
    <button
      type="button"
      onClick={submit}
      disabled={busy || (!loaded && !complete)}
      className={complete && !loaded ? "is-ready" : ""}
    >
      {loaded
        ? "Retirer ou remplacer"
        : complete
          ? "Charger"
          : <span className="access-key-progress" aria-hidden="true">
            {Array.from({ length: ACCESS_KEY_LENGTH }, (_, index) => <i key={index} className={index < rawLength ? "filled" : ""}/>)}
          </span>}
    </button>
  </div>;
}

function About({ accessToken, onAccessTokenChange }) {
  return <section className="about">
    <header className="about-heading">
      <p className="eyebrow">À propos</p>
    </header>
    <div className="about-copy">
      <p>cette application rassemble tout les épisodes TBA textuels, audio et vidéo référencé, pour un meilleur suivi, une meilleure organisation et gestion de temps.</p>
      <p>désigné par Claude, codé par Codex</p>
    </div>
    <section className="about-local">
      <header className="about-section-heading">
        <p className="eyebrow">Données locales</p>
        <p>Une copie légère de la liste reste dans ce navigateur pour accélérer l’ouverture et limiter les lectures Supabase.</p>
      </header>
      <AccessKeyModule accessToken={accessToken} onAccessTokenChange={onAccessTokenChange}/>
    </section>
    <section className="stack-section">
      <p className="eyebrow">Stack technique</p>
      <div className="stack-list">
        <span><strong>React</strong> Interface</span>
        <span><strong>Vite</strong> Build statique</span>
        <span><strong>Supabase</strong> PostgreSQL · Storage médias et Markdown · Edge Functions</span>
        <span><strong>Cloudflare R2</strong> Stockage hybride des épisodes</span>
        <span><strong>Firebase Hosting</strong> Déploiement web</span>
        <span><strong>localStorage</strong> Cache vitrine · Signets</span>
      </div>
    </section>
  </section>;
}

function Empty({ title, text }) {
  return <div className="empty"><span>Ø</span><h2>{title}</h2><p>{text}</p></div>;
}

function SkeletonLine({ className = "" }) {
  return <span className={`skeleton-surface skeleton-line ${className}`.trim()}/>;
}

function EpisodeCardSkeleton() {
  return <article className="episode-card skeleton-card" aria-hidden="true">
    <div className="skeleton-surface skeleton-poster"/>
    <div className="card-copy">
      <div className="skeleton-topline"><SkeletonLine className="short"/><SkeletonLine className="short"/></div>
      <SkeletonLine className="title"/>
      <SkeletonLine/>
      <SkeletonLine className="medium"/>
      <div className="skeleton-pills"><SkeletonLine/><SkeletonLine/><SkeletonLine/></div>
      <SkeletonLine className="link"/>
    </div>
  </article>;
}

function LoadingSkeleton({ view }) {
  if (view === "episode") {
    return <article className="episode-page skeleton-page" aria-label="Chargement de l’épisode" aria-busy="true">
      <SkeletonLine className="back-line"/>
      <div className="episode-hero">
        <div className="skeleton-surface skeleton-hero-poster"/>
        <div className="skeleton-hero-copy">
          <SkeletonLine className="eyebrow-line"/>
          <SkeletonLine className="hero-title"/>
          <SkeletonLine className="hero-title compact"/>
          <SkeletonLine/>
          <SkeletonLine className="medium"/>
          <div className="skeleton-pills"><SkeletonLine/><SkeletonLine/><SkeletonLine/></div>
        </div>
      </div>
      <div className="skeleton-body">
        <SkeletonLine className="content-label"/>
        <div className="skeleton-surface skeleton-content"/>
      </div>
    </article>;
  }

  if (view === "archive" || view === "bookmarks") {
    return <section className="skeleton-archive" aria-label="Chargement des épisodes" aria-busy="true">
      <header className="skeleton-heading"><div><SkeletonLine className="eyebrow-line"/><SkeletonLine className="heading-line"/></div><SkeletonLine className="heading-copy"/></header>
      {view === "archive" && <div className="skeleton-filters"><SkeletonLine/><SkeletonLine/><SkeletonLine/></div>}
      <div className="episode-grid"><EpisodeCardSkeleton/><EpisodeCardSkeleton/><EpisodeCardSkeleton/></div>
    </section>;
  }

  return <section className="home skeleton-home" aria-label="Chargement du dernier épisode" aria-busy="true">
    <header className="home-heading"><SkeletonLine className="home-label"/><SkeletonLine className="home-label"/></header>
    <EpisodeCardSkeleton/>
  </section>;
}

function SupabaseNotice({ text }) {
  return <aside className="supabase-notice" role="status">
    <span aria-hidden="true">!</span>
    <div><strong>Supabase indisponible</strong><p>{text}</p></div>
  </aside>;
}

function FileField({ label, accept, file, existing, onChange, onRemove }) {
  const input = useRef(null);
  const selected = file?.name || (existing ? "Fichier déjà envoyé" : "");
  return (
    <div className="file-field">
      <span>{label}</span>
      <button type="button" onClick={() => input.current.click()}><Icon name="upload"/>{selected || "Choisir un fichier"}</button>
      <input ref={input} type="file" accept={accept} hidden onChange={(event) => onChange(event.target.files?.[0] || null)}/>
      {selected && <button type="button" className="remove-file" onClick={onRemove}>Retirer</button>}
    </div>
  );
}

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1000) return `${value} o`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} Ko`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} Mo`;
  return `${(value / 1_000_000_000).toFixed(2)} Go`;
}

function StoragePanel({ episodes, status, loading, migrating, onRefresh, onMigrate }) {
  const [archive, setArchive] = useState({ running: false, message: "", errors: 0, current: 0, total: 0 });
  if (loading && !status) return <section className="storage-panel"><div className="storage-loading"><span className="button-spinner"/>Lecture du stockage…</div></section>;
  const config = status?.settings ?? {};
  const used = Number(status?.supabaseBytes ?? 0);
  const quota = Number(config.quotaBytes ?? 1_000_000_000);
  const percent = Math.min(100, quota ? used / quota * 100 : 0);
  const r2Used = Number(status?.r2Bytes ?? 0);
  const r2Percent = Math.min(100, r2Used / R2_INCLUDED_BYTES * 100);
  const r2PercentLabel = r2Percent > 0 && r2Percent < 0.1 ? r2Percent.toFixed(2) : r2Percent.toFixed(1);
  const archiveBytes = episodes.reduce((sum, episode) => sum + Number(episode.storageBytes || 0), 0);
  const jobByEpisode = new Map((status?.jobs ?? []).map((job) => [job.episode_id, job]));
  const startArchive = async (event) => {
    event.preventDefault();
    if (archive.running) return;
    setArchive({ running: true, message: "Préparation…", errors: 0, current: 0, total: 0 });
    try {
      const { downloadEpisodeArchive } = await import("./archive.js");
      const result = await downloadEpisodeArchive({
        onProgress: ({ current, total, label }) => setArchive((state) => ({ ...state, current, total, message: label })),
      });
      setArchive({ running: false, message: result.errors.length ? `Archive créée · ${result.errors.length} fichier${result.errors.length > 1 ? "s" : ""} manquant${result.errors.length > 1 ? "s" : ""}` : "Archive téléchargée", errors: result.errors.length, current: result.episodes, total: result.episodes });
    } catch (error) {
      if (error?.name === "AbortError") {
        setArchive({ running: false, message: "Téléchargement annulé", errors: 0, current: 0, total: 0 });
      } else {
        setArchive({ running: false, message: error?.message || "Archive impossible", errors: 1, current: 0, total: 0 });
      }
    }
  };
  return <section className="storage-panel">
    <header className="manage-heading storage-heading">
      <div><p className="eyebrow">Infrastructure</p><h2>Stockage</h2></div>
      <button type="button" className="storage-refresh" onClick={onRefresh} disabled={loading}>{loading ? "Actualisation…" : "Actualiser"}</button>
    </header>
    <div className="storage-overview">
      <article className="storage-card primary-storage">
        <div><span>Supabase</span><strong>{formatBytes(used)}</strong><small>sur {formatBytes(quota)}</small></div>
        <div className="storage-meter"><i style={{ width: `${percent}%` }}/><b style={{ left: `${config.triggerPercent ?? 75}%` }}/></div>
        <p>{percent.toFixed(1)} % utilisé · seuil {config.triggerPercent ?? 75} %</p>
      </article>
      <article className="storage-card r2-storage">
        <div><span>Cloudflare R2</span><strong>{formatBytes(r2Used)}</strong><small>sur {formatBytes(R2_INCLUDED_BYTES)} inclus · {config.r2Ready ? config.r2Bucket : "Non configuré"}</small></div>
        <div className="storage-meter"><i style={{ width: `${r2Percent}%`, minWidth: r2Used ? 3 : 0 }}/></div>
        <p>{r2PercentLabel} % utilisé · {!config.r2Ready ? "configuration requise" : config.r2Enabled ? "connexion opérationnelle" : "configuré · désactivé"}</p>
      </article>
      <article className="storage-card compact storage-status-card">
        <span>Migration automatique</span><strong>{config.autoMigrationEnabled && config.r2Enabled ? "Active" : config.autoMigrationEnabled ? "Suspendue" : "Désactivée"}</strong>
        <span>Fichiers orphelins</span><strong>{status?.orphan?.objects ?? 0} · {formatBytes(status?.orphan?.bytes)}</strong>
      </article>
      <article className="storage-card compact archive-card" id="telecharger-archive">
        <span>Télécharger l’archive</span>
        <a href="#telecharger-archive" onClick={startArchive} aria-disabled={archive.running} aria-busy={archive.running}>{archive.running ? `${archive.current}/${archive.total || "…"}` : "Télécharger"}</a>
        <small className={archive.errors ? "error" : ""} aria-live="polite">{archive.message || `${episodes.length} épisode${episodes.length > 1 ? "s" : ""} · ${formatBytes(archiveBytes)}${typeof window.showSaveFilePicker === "function" ? "" : " · préparation en mémoire"}`}</small>
      </article>
    </div>
    <div className="storage-episodes">
      <div className="storage-list-heading"><h3>Épisodes</h3><span>{episodes.length} au total</span></div>
      {episodes.map((episode) => {
        const job = jobByEpisode.get(episode.uid);
        const busy = migrating?.episodeId === episode.uid || (job && job.status !== "error");
        const target = episode.storageProvider === "r2" ? "supabase" : "r2";
        const tooLargeForSupabase = target === "supabase" && [episode.storageData?.body, episode.storageData?.image, episode.storageData?.audio]
          .filter(Boolean)
          .some((item) => Number(item.size ?? 0) > MAX_SUPABASE_FILE_BYTES);
        return <article className="storage-episode" key={episode.uid}>
          <div className={`provider-dot ${episode.storageProvider}`}/>
          <div><strong>TBA — {formatEpisodeNumber(episode.number)} · {episode.title}</strong><span>{formatBytes(episode.storageBytes)} · {episode.storageProvider === "r2" ? "Cloudflare R2" : "Supabase"}</span>{tooLargeForSupabase && <small>Retour vers Supabase impossible : un fichier dépasse 50 Mo.</small>}{job?.error && <small>{job.error}</small>}</div>
          <button type="button" className={busy ? "is-busy" : ""} onClick={() => onMigrate(episode, target)} disabled={busy || tooLargeForSupabase || (target === "r2" && !config.r2Enabled)} aria-busy={busy}>{busy ? `${migrating?.current ?? 0}/${migrating?.total ?? 0}` : `Vers ${target === "r2" ? "R2" : "Supabase"}`}</button>
        </article>;
      })}
    </div>
  </section>;
}

function SettingsPanel({ status, busy, onSave, onSetupR2, onToggleR2, onChangePin }) {
  const [autoMigrationEnabled, setAutoMigrationEnabled] = useState(false);
  const [triggerPercent, setTriggerPercent] = useState(75);
  const [targetPercent, setTargetPercent] = useState(60);
  const [cloudflare, setCloudflare] = useState({ accountId: "", apiToken: "", parentAccessKeyId: "", bucket: "tba-reader-media" });
  const [nextPin, setNextPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!status?.settings) return;
    setAutoMigrationEnabled(Boolean(status.settings.autoMigrationEnabled));
    setTriggerPercent(Number(status.settings.triggerPercent ?? 75));
    setTargetPercent(Number(status.settings.targetPercent ?? 60));
    if (status.settings.r2Bucket) setCloudflare((current) => ({ ...current, bucket: status.settings.r2Bucket }));
  }, [status]);
  const run = async (task, success) => {
    try { setError(""); setMessage(""); await task(); setMessage(success); } catch (actionError) { setError(actionError?.message || "Action impossible."); }
  };
  return <section className="settings-panel">
    <header className="manage-heading"><div><p className="eyebrow">Configuration</p><h2>Paramètres</h2></div></header>
    {message && <div className="admin-notice">{message}</div>}
    {error && <p className="form-error">{error}</p>}
    <section className="settings-card">
      <div className="settings-card-heading"><div><span>Automatisation</span><h3>Migration auto</h3></div><label className="switch"><input type="checkbox" checked={autoMigrationEnabled} onChange={(event) => setAutoMigrationEnabled(event.target.checked)}/><i/></label></div>
      <p>Désactivée par défaut. R2 doit être activé pour accepter un fichier supérieur à 50 Mo.</p>
      <div className="settings-grid"><label><span>Déclenchement (%)</span><input type="number" min="2" max="99" value={triggerPercent} onChange={(event) => setTriggerPercent(Number(event.target.value))}/></label><label><span>Objectif (%)</span><input type="number" min="1" max="98" value={targetPercent} onChange={(event) => setTargetPercent(Number(event.target.value))}/></label></div>
      <button className="settings-primary" type="button" disabled={busy} onClick={() => run(() => onSave({ autoMigrationEnabled, triggerPercent, targetPercent }), "Paramètres de stockage enregistrés.")}>Enregistrer</button>
    </section>
    <section className="settings-card">
      <div className="settings-card-heading"><div><span>Cloudflare</span><h3>Bucket R2</h3></div><div className="settings-card-controls"><em className={status?.settings?.r2Enabled ? "ready" : ""}>{!status?.settings?.r2Ready ? "À configurer" : status.settings.r2Enabled ? "Actif" : "Désactivé"}</em><label className="switch"><input type="checkbox" aria-label="Activer Cloudflare R2" checked={Boolean(status?.settings?.r2Enabled)} disabled={busy || !status?.settings?.r2Ready} onChange={(event) => run(() => onToggleR2(event.target.checked), event.target.checked ? "Cloudflare R2 activé." : "Cloudflare R2 désactivé.")}/><i/></label></div></div>
      <p>L’assistant crée le bucket, configure CORS et active son adresse r2.dev.</p>
      <div className="settings-grid"><label><span>Account ID</span><input value={cloudflare.accountId} onChange={(event) => setCloudflare((old) => ({ ...old, accountId: event.target.value }))}/></label><label><span>Access Key ID parent</span><input value={cloudflare.parentAccessKeyId} onChange={(event) => setCloudflare((old) => ({ ...old, parentAccessKeyId: event.target.value }))}/></label><label className="wide"><span>Jeton API R2</span><input type="password" autoComplete="off" value={cloudflare.apiToken} onChange={(event) => setCloudflare((old) => ({ ...old, apiToken: event.target.value }))}/></label><label className="wide"><span>Nom du bucket</span><input value={cloudflare.bucket} onChange={(event) => setCloudflare((old) => ({ ...old, bucket: event.target.value.toLowerCase() }))}/></label></div>
      <button className="settings-primary" type="button" disabled={busy} onClick={() => run(() => onSetupR2(cloudflare), "Cloudflare R2 est prêt.")}>{status?.settings?.r2Ready ? "Tester et reconfigurer" : "Créer et connecter R2"}</button>
    </section>
    <section className="settings-card">
      <div className="settings-card-heading"><div><span>Sécurité</span><h3>Changer le PIN</h3></div></div>
      <div className="settings-grid"><label><span>Nouveau PIN</span><input type="password" inputMode="numeric" maxLength="6" value={nextPin} onChange={(event) => setNextPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/></label><label><span>Confirmation</span><input type="password" inputMode="numeric" maxLength="6" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/></label></div>
      <button className="settings-primary" type="button" disabled={busy || nextPin.length !== 6 || nextPin !== confirmPin} onClick={() => run(async () => { await onChangePin(nextPin); setNextPin(""); setConfirmPin(""); }, "PIN modifié. Il sera demandé à la prochaine connexion.")}>Modifier le PIN</button>
    </section>
  </section>;
}

function Admin({ authReady, authenticated, episodes, markdownOpen, onMarkdownOpenChange, onSave, onDelete, onRenumber, onSignIn, onLoadEpisode, onGetStorageStatus, onSaveStorageSettings, onSetupR2, onToggleR2, onChangePin, onMigrate, onClose }) {
  const [pin, setPin] = useState("");
  const [checkingPin, setCheckingPin] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("create");
  const [editingId, setEditingId] = useState("");
  const setMarkdownOpen = onMarkdownOpenChange;
  const [manageQuery, setManageQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [renumberOpen, setRenumberOpen] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState("");
  const [storageStatus, setStorageStatus] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [migrating, setMigrating] = useState(null);
  const autoMigrationLock = useRef(false);
  const savingLock = useRef(false);
  const pendingIdentity = useRef(null);
  const originalBody = useRef("");
  const initial = { title: "", description: "", body: "", type: "Texte", date: new Date().toISOString().slice(0, 10), duration: "", tags: "", youtube: "", image: "", imagePath: "", imageFile: null, imagePreview: "", audio: "", audioPath: "", audioFile: null, token: "", accessKey: "", tokenAction: "keep" };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (authenticated || pin.length !== 6) return undefined;
    let active = true;
    setCheckingPin(true);
    onSignIn(pin)
      .then(() => {
        if (!active) return;
        setError("");
      })
      .catch((verifyError) => {
        if (!active) return;
        setError(verifyError?.message || "Code incorrect. Réessaie.");
        window.setTimeout(() => setPin(""), 500);
      })
      .finally(() => {
        if (active) setCheckingPin(false);
      });
    return () => { active = false; };
  }, [authenticated, pin, onSignIn]);
  useEffect(() => {
    if (authenticated) setPin("");
  }, [authenticated]);
  const refreshStorage = async () => {
    if (!authenticated) return null;
    try {
      setStorageLoading(true);
      const nextStatus = await onGetStorageStatus();
      setStorageStatus(nextStatus);
      return nextStatus;
    } catch (storageError) {
      setError(storageError?.message || "État du stockage indisponible.");
      return null;
    } finally {
      setStorageLoading(false);
    }
  };
  useEffect(() => {
    if (!authenticated) return;
    refreshStorage();
  }, [authenticated]);
  const migrate = async (episode, target, automatic = false) => {
    if (migrating) return;
    try {
      setError("");
      setMigrating({ episodeId: episode.uid, current: 0, total: 0, label: "Préparation" });
      await onMigrate(episode, target, (progress) => setMigrating({ episodeId: episode.uid, ...progress }));
      setNotice(`${episode.title || "Épisode"} déplacé vers ${target === "r2" ? "Cloudflare R2" : "Supabase"}.`);
      await refreshStorage();
    } catch (migrationError) {
      setError(migrationError?.message || "Migration interrompue.");
      if (!automatic) setTab("storage");
    } finally {
      setMigrating(null);
    }
  };
  useEffect(() => {
    if (!storageStatus?.settings?.autoMigrationEnabled || !storageStatus.settings.r2Enabled || autoMigrationLock.current || migrating) return;
    const quota = Number(storageStatus.settings.quotaBytes || 1_000_000_000);
    const trigger = quota * Number(storageStatus.settings.triggerPercent || 75) / 100;
    if (Number(storageStatus.supabaseBytes) <= trigger) return;
    autoMigrationLock.current = true;
    (async () => {
      let projected = Number(storageStatus.supabaseBytes);
      const targetBytes = quota * Number(storageStatus.settings.targetPercent || 60) / 100;
      const candidates = [...(storageStatus.episodes ?? [])]
        .filter((episode) => episode.storage_provider === "supabase")
        .sort((a, b) => Number(b.storage_bytes) - Number(a.storage_bytes));
      for (const candidate of candidates) {
        if (projected <= targetBytes) break;
        await migrate({ uid: candidate.id, title: candidate.title }, "r2", true);
        projected -= Number(candidate.storage_bytes || 0);
      }
    })().finally(() => { autoMigrationLock.current = false; });
  }, [storageStatus]);
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const chooseFile = async (kind, file) => {
    setError("");
    if (kind === "image") {
      if (form.imagePreview) URL.revokeObjectURL(form.imagePreview);
      setForm((old) => ({ ...old, imageFile: file, imagePreview: file ? URL.createObjectURL(file) : "" }));
    } else {
      try {
        await validateAudioFile(file);
        update("audioFile", file);
      } catch (audioError) {
        update("audioFile", null);
        setError(audioError.message || "Ce fichier audio ne peut pas être publié.");
      }
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (savingLock.current) return;
    if (!form.title.trim() || !form.description.trim()) return setError("Titre et description requis.");
    if (form.accessKey && !isValidAccessKey(form.accessKey)) return setError("La clé d’accès doit respecter le format TBA-ABC1-23.");
    const previous = episodes.find((episode) => episode.id === editingId);
    if (!previous && !pendingIdentity.current) {
      pendingIdentity.current = { uid: makeUuid(), id: makeShortId() };
    }
    const identity = previous || pendingIdentity.current;
    const { imageFile, audioFile, imagePreview, accessKey, tokenAction, ...episodeFields } = form;
    try {
      savingLock.current = true;
      setSaving(true);
      const token = tokenAction === "remove"
        ? ""
        : accessKey
          ? await hashAccessKey(accessKey)
          : form.token;
      await onSave({
        ...episodeFields,
        token,
        uid: identity.uid,
        id: identity.id,
        number: previous?.number || makeNumber(episodes),
        tags: [...new Set(form.tags.split(/[,#]/).map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
        duration: form.duration.trim() || (form.type === "Vocal" ? "Audio" : "5 min"),
        palette: previous?.palette ?? episodes.length % 6,
        createdAt: previous?.createdAt || new Date().toISOString(),
        storageProvider: previous?.storageProvider || "supabase",
        storageBytes: previous?.storageBytes || 0,
        storageData: previous?.storageData || null,
      }, { imageFile, audioFile, bodyChanged: !previous || form.body !== originalBody.current });
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      setNotice(previous ? "Modifications enregistrées." : "Épisode publié.");
      setEditingId("");
      setMarkdownOpen(false);
      pendingIdentity.current = null;
      originalBody.current = "";
      setForm(initial);
      setError("");
      setTab("manage");
      await refreshStorage();
    } catch (saveError) {
      setError(saveError?.message || "Enregistrement Supabase impossible.");
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  };
  const startCreate = () => { setEditingId(""); setMarkdownOpen(false); pendingIdentity.current = null; originalBody.current = ""; setForm(initial); setError(""); setNotice(""); setTab("create"); };
  const startEdit = async (episode) => {
    if (loadingEditId) return;
    try {
      setLoadingEditId(episode.id);
      setError("");
      const detailedEpisode = await onLoadEpisode(episode);
      originalBody.current = detailedEpisode.body;
      setEditingId(detailedEpisode.id);
      setMarkdownOpen(false);
      setForm({ title: detailedEpisode.title, description: detailedEpisode.description, body: detailedEpisode.body, type: detailedEpisode.type, date: detailedEpisode.date, duration: detailedEpisode.duration, tags: detailedEpisode.tags.join(", "), youtube: detailedEpisode.youtube || "", image: detailedEpisode.image || "", imagePath: detailedEpisode.imagePath || "", imageFile: null, imagePreview: "", audio: detailedEpisode.audio || "", audioPath: detailedEpisode.audioPath || "", audioFile: null, token: detailedEpisode.token || "", accessKey: "", tokenAction: "keep" });
      setNotice("");
      setTab("create");
    } catch (loadError) {
      setError(loadError?.message || "Chargement du contenu impossible.");
    } finally {
      setLoadingEditId("");
    }
  };
  const managedEpisodes = episodes.filter((episode) => `${episode.number} ${episode.id} ${episode.title} ${displayType(episode.type)}`.toLowerCase().includes(manageQuery.toLowerCase()));
  const renumberPlan = [...episodes]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.uid.localeCompare(b.uid))
    .map((episode, index) => ({ episode, nextNumber: index + 1 }))
    .filter(({ episode, nextNumber }) => episode.number !== nextNumber);
  const renumber = async () => {
    if (renumbering) return;
    try {
      setRenumbering(true);
      setError("");
      await onRenumber();
      setNotice(`${episodes.length} épisode${episodes.length > 1 ? "s" : ""} renuméroté${episodes.length > 1 ? "s" : ""}.`);
      setRenumberOpen(false);
    } catch (renumberError) {
      setError(renumberError?.message || "Renumérotation impossible.");
    } finally {
      setRenumbering(false);
    }
  };
  const deleteEpisode = async (episode) => {
    if (deleting) return;
    try {
      setDeleting(true);
      setError("");
      await onDelete(episode);
      setNotice("Épisode et médias supprimés.");
      setDeleteTargetId("");
      await refreshStorage();
    } catch (deleteError) {
      setError(deleteError?.message || "Suppression impossible.");
    } finally {
      setDeleting(false);
    }
  };
  const contentMode = tab === "create" || tab === "manage";
  if (!authReady) return <div className="markdown-editor-loading" aria-label="Vérification de la session" aria-busy="true"><span className="button-spinner"/></div>;
  if (!authenticated) return (
    <section className="pin-page">
      <button type="button" className="back" onClick={onClose}><Icon name="back"/> Retour au site</button>
      <div className="pin-panel">
        <div className="pin-icon"><Icon name="lock" size={27}/></div>
        <p className="eyebrow">Espace privé</p>
        <p className="pin-intro">Entre code PIN.</p>
        <label>
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength="6" value={pin} onChange={(event) => { setError(""); setPin(event.target.value.replace(/\D/g, "").slice(0, 6)); }} placeholder="••••••" aria-label="Code PIN" aria-invalid={Boolean(error)}/>
        </label>
        <div className="pin-progress" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i className={index < pin.length ? "filled" : ""} key={index}/>)}</div>
        {(error || checkingPin) && <p className={`pin-status ${error ? "error" : ""}`} aria-live="polite">{error || "Vérification…"}</p>}
      </div>
    </section>
  );
  if (markdownOpen) return <Suspense fallback={<div className="markdown-editor-loading" aria-label="Chargement de l’éditeur" aria-busy="true"><span className="button-spinner"/></div>}>
    <MarkdownEditor
      value={form.body}
      onValidate={(body) => { update("body", body); setMarkdownOpen(false); }}
      onCancel={() => setMarkdownOpen(false)}
    />
  </Suspense>;
  return (
    <div className="admin-page">
      <button className="back" onClick={onClose}><Icon name="back"/> Quitter l’administration</button>
      <header className="admin-heading"><p className="eyebrow">Espace créateur</p><p>Publie, organise et répartis les épisodes entre Supabase et Cloudflare R2.</p></header>
      <nav className="admin-navigation" aria-label="Menu créateur">
        <button
          className="admin-mode-switch"
          type="button"
          onClick={() => setTab(contentMode ? "storage" : "create")}
          aria-label={`Passer en mode ${contentMode ? "Infrastructure" : "Contenu"}`}
        >{contentMode ? "Contenu" : "Infrastructure"}</button>
        {contentMode ? <>
          <button type="button" className={tab === "create" ? "active" : ""} onClick={startCreate}>{editingId ? "Modifier" : "Créer"}</button>
          <button type="button" className={tab === "manage" ? "active" : ""} onClick={() => setTab("manage")}>Gérer</button>
        </> : <>
          <button type="button" className={tab === "storage" ? "active" : ""} onClick={() => setTab("storage")}>Stockage</button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => { setTab("settings"); refreshStorage(); }}>Paramètres</button>
        </>}
      </nav>
      {notice && <div className="admin-notice">{notice}</div>}
      {tab === "create" ? <form className="editor" onSubmit={submit}>
        <header className="editor-title"><div><p className="eyebrow">{editingId ? `TBA — ${formatEpisodeNumber(episodes.find((episode) => episode.id === editingId)?.number)}` : "Nouvel épisode"}</p><h2>{editingId ? "Modifier épisode" : "Créer épisode"}</h2></div></header>
        <section className="editor-section">
          <div className="section-label"><span>01</span><div><h3>L’essentiel</h3><p>Ce que lecteur voit en premier.</p></div></div>
          <div className="field-grid">
            <label className="wide"><span>Titre *</span><input value={form.title} onChange={(e) => update("title", e.target.value)} placeholder="Titre de l’épisode"/></label>
            <div className="admin-format-field">
              <span>Format *</span>
              <FormatFilter value={form.type} onChange={(value) => update("type", value)} options={EPISODE_FORMAT_OPTIONS}/>
            </div>
            <label><span>Durée</span><input value={form.duration} onChange={(e) => update("duration", e.target.value)} placeholder="8 min ou 09:42"/></label>
            <label className="wide"><span>Description courte *</span><textarea rows="3" value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="Accroche visible dans l’archive"/></label>
          </div>
        </section>
        <section className="editor-section">
          <div className="section-label"><span>02</span><div><h3>Contenu Markdown</h3><p>Corps complet de l’épisode.</p></div></div>
          <button className="body-editor-button" type="button" onClick={() => setMarkdownOpen(true)}>{form.body?.trim() ? "Modifier le contenu" : "Rédiger le contenu"}</button>
        </section>
        <section className="editor-section">
          <div className="section-label"><span>03</span><div><h3>Classement</h3><p>Date et sujets alimentent archive automatiquement.</p></div></div>
          <div className="field-grid">
            <div className="admin-date-field">
              <span>Date</span>
              <DatePicker value={form.date} onChange={(value) => update("date", value)}/>
            </div>
            <label><span>Hashtags</span><input value={form.tags} onChange={(e) => update("tags", e.target.value)} placeholder="japon, mémoire, voyage"/></label>
          </div>
        </section>
        <section className="editor-section">
          <div className="section-label"><span>04</span><div><h3>Médias</h3><p>Tout reste optionnel.</p></div></div>
          <div className="field-grid">
            <label className="wide"><span>Lien YouTube</span><input type="text" inputMode="url" value={form.youtube} onChange={(e) => update("youtube", e.target.value)} placeholder="https://youtube.com/watch?v=…"/></label>
            <FileField label="Image ou visuel généré par défaut" accept="image/*" file={form.imageFile} existing={form.image} onChange={(file) => chooseFile("image", file)} onRemove={() => setForm((old) => ({ ...old, image: "", imagePath: "", imageFile: null, imagePreview: "" }))}/>
            <FileField label="Fichier audio (MP3, AAC ou M4A)" accept="audio/mpeg,audio/aac,audio/x-aac,audio/mp4,audio/x-m4a,.mp3,.aac,.m4a" file={form.audioFile} existing={form.audio} onChange={(file) => chooseFile("audio", file)} onRemove={() => setForm((old) => ({ ...old, audio: "", audioPath: "", audioFile: null }))}/>
          </div>
        </section>
        <section className="editor-section">
          <div className="section-label"><span>05</span><div><h3>Accès</h3><p>Vide signifie visible pour tout le monde.</p></div></div>
          <div className="admin-access-key">
            <AccessKeyInput
              value={form.accessKey}
              onChange={(accessKey) => setForm((old) => ({
                ...old,
                accessKey,
                tokenAction: accessKey ? "replace" : old.tokenAction === "remove" ? "remove" : "keep",
              }))}
              placeholder={form.token && form.tokenAction !== "remove" ? "Nouvelle clé (optionnel)" : "TBA-ABC1-23"}
              ariaLabel="Clé d’accès de l’épisode"
              className={isValidAccessKey(form.accessKey) ? "is-complete" : ""}
            />
            {form.token && (
              <button
                type="button"
                onClick={() => setForm((old) => ({
                  ...old,
                  accessKey: "",
                  tokenAction: old.tokenAction === "remove" ? "keep" : "remove",
                }))}
                className={form.tokenAction === "remove" ? "undo-token-removal" : "remove-token"}
              >
                {form.tokenAction === "remove" ? "Conserver la clé actuelle" : "Retirer la clé actuelle"}
              </button>
            )}
          </div>
        </section>
        {form.title && <section className="editor-section preview-section"><div className="section-label"><span>06</span><div><h3>Aperçu</h3><p>Rendu card public, sans action.</p></div></div><div className="editor-preview"><EpisodeCard preview episode={{ ...form, image: form.imagePreview || form.image, number: episodes.find((episode) => episode.id === editingId)?.number || makeNumber(episodes), tags: form.tags.split(/[,#]/).map((item) => item.trim()).filter(Boolean), duration: form.duration || "5 min", palette: episodes.length % 6 }}/></div></section>}
        {error && <p className="form-error">{error}</p>}
        <div className="editor-actions">{editingId && <button className="ghost-button" type="button" onClick={startCreate} disabled={saving}>Annuler modification</button>}<button className="primary" type="submit" disabled={saving} aria-busy={saving}>{saving ? <><span className="button-spinner" aria-hidden="true"/>Envoi vers Supabase…</> : <><Icon name={editingId ? "arrow" : "plus"}/>{editingId ? "Enregistrer les modifications" : "Publier l’épisode"}</>}</button></div>
      </form> : tab === "manage" ? <section className="manage">
        <header className="manage-heading">
          <div><p className="eyebrow">Bibliothèque</p><h2>Gérer épisodes</h2></div>
          {renumberPlan.length > 0 && <button type="button" className="renumber-button" onClick={() => { setRenumberOpen((open) => !open); setError(""); }} aria-expanded={renumberOpen}><Icon name="refresh" size={17}/> Renuméroter</button>}
        </header>
        {renumberOpen && <section className="renumber-panel">
          <div><p className="eyebrow">Aperçu</p><h3>Repartir de TBA 001 ?</h3><p>Les plus anciens passent en premier. Les liens et signets resteront identiques.</p></div>
          <div className="renumber-preview">{renumberPlan.slice(0, 6).map(({ episode, nextNumber }) => <span key={episode.id}><strong>{formatEpisodeNumber(episode.number)}</strong><Icon name="arrow" size={14}/><strong>{formatEpisodeNumber(nextNumber)}</strong><small>{episode.title}</small></span>)}</div>
          {renumberPlan.length > 6 && <p className="renumber-more">+ {renumberPlan.length - 6} autres changements</p>}
          <div className="renumber-actions"><button type="button" className="ghost-button" onClick={() => setRenumberOpen(false)} disabled={renumbering}>Annuler</button><button type="button" className="primary" onClick={renumber} disabled={renumbering} aria-busy={renumbering}>{renumbering ? <><span className="button-spinner" aria-hidden="true"/>Renumérotation…</> : "Confirmer"}</button></div>
        </section>}
        {error && <p className="form-error">{error}</p>}
        <label className="search-field manage-search"><Icon name="search"/><input value={manageQuery} onChange={(event) => setManageQuery(event.target.value)} placeholder="Chercher par titre, numéro, format…"/></label>
        <div className="manage-list">{managedEpisodes.map((episode) => <article className="manage-row" key={episode.id}>
          <div className="manage-poster"><Poster episode={episode}/></div>
          <div className="manage-copy"><span>TBA — {formatEpisodeNumber(episode.number)} · {displayType(episode.type)}</span><strong>{episode.title}</strong><small>{displayDate(episode.date)} · {episode.token ? "Accès restreint" : "Public"}</small></div>
          {deleteTargetId === episode.id ? <div className="delete-confirmation">
            <div><strong>Supprimer définitivement ?</strong><span>« {episode.title} » et ses médias seront supprimés.</span></div>
            <div className="delete-confirm-actions"><button type="button" className="cancel-delete" onClick={() => setDeleteTargetId("")} disabled={deleting}>Annuler</button><button type="button" className="confirm-delete" onClick={() => deleteEpisode(episode)} disabled={deleting} aria-busy={deleting}>{deleting ? <><span className="delete-spinner" aria-hidden="true"/>Suppression…</> : "Confirmer"}</button></div>
          </div> : <div className="manage-actions"><button type="button" className="edit-action" onClick={() => startEdit(episode)} disabled={deleting || Boolean(loadingEditId)}> {loadingEditId === episode.id ? "Chargement…" : "Modifier"}</button><button type="button" className="delete-action" onClick={() => { setDeleteTargetId(episode.id); setError(""); }} disabled={deleting || Boolean(loadingEditId)}>Supprimer</button></div>}
        </article>)}</div>
        {!managedEpisodes.length && <Empty title="Aucun épisode" text="Change recherche."/>}
      </section> : tab === "storage" ? <StoragePanel episodes={episodes} status={storageStatus} loading={storageLoading} migrating={migrating} onRefresh={refreshStorage} onMigrate={migrate}/>
        : <SettingsPanel
          status={storageStatus}
          busy={settingsBusy}
          onSave={async (nextSettings) => { setSettingsBusy(true); try { await onSaveStorageSettings(nextSettings); await refreshStorage(); } finally { setSettingsBusy(false); } }}
          onSetupR2={async (config) => { setSettingsBusy(true); try { await onSetupR2(config); await refreshStorage(); } finally { setSettingsBusy(false); } }}
          onToggleR2={async (enabled) => { setSettingsBusy(true); try { await onToggleR2(enabled); await refreshStorage(); } finally { setSettingsBusy(false); } }}
          onChangePin={async (nextPin) => { setSettingsBusy(true); try { await onChangePin(nextPin); } finally { setSettingsBusy(false); } }}
        />}
    </div>
  );
}

export default function App() {
  const initialRoute = useRef(readRoute());
  const [accessToken, setAccessToken] = useState(readAccessToken);
  const accessTokenRef = useRef(accessToken);
  const [episodes, setEpisodes] = useState([]);
  const [episodeDetails, setEpisodeDetails] = useState({});
  const [showcaseCache, setShowcaseCache] = useState(() => readShowcaseCache(accessToken));
  const refreshEpisodesRef = useRef(null);
  const [supabaseLoading, setSupabaseLoading] = useState(() => !isShowcaseCacheFresh(showcaseCache));
  const [supabaseError, setSupabaseError] = useState("");
  const [hasFreshData, setHasFreshData] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [view, setView] = useState(initialRoute.current.view);
  const [selectedId, setSelectedId] = useState(initialRoute.current.episodeId);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminMarkdownOpen, setAdminMarkdownOpen] = useState(false);
  const [adminSession, setAdminSession] = useState(null);
  const [adminAuthReady, setAdminAuthReady] = useState(false);
  const [archiveTag, setArchiveTag] = useState(initialRoute.current.tag);
  const [bookmarks, setBookmarks] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY));
      return new Set(Array.isArray(saved) ? saved : []);
    } catch {
      return new Set();
    }
  });
  const fullSorted = useMemo(() => [...episodes].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [episodes]);
  const visibleSorted = useMemo(
    () => filterEpisodesByAccess(fullSorted, accessToken),
    [accessToken, fullSorted],
  );
  const cachedSorted = useMemo(() => [...showcaseCache.episodes].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [showcaseCache]);
  const sorted = hasFreshData ? visibleSorted : cachedSorted;
  const selectedSummary = useMemo(() => sorted.find((episode) => episode.id === selectedId) || null, [sorted, selectedId]);
  const selected = selectedSummary ? episodeDetails[selectedId] || selectedSummary : null;
  const allTags = useMemo(() => [...new Set(sorted.flatMap((episode) => episode.tags))].sort(), [sorted]);
  const bookmarkedEpisodes = useMemo(() => sorted.filter((episode) => bookmarks.has(episode.id)), [sorted, bookmarks]);
  useEffect(() => {
    let active = true;
    getAdminSession()
      .then((session) => { if (active) setAdminSession(session); })
      .finally(() => { if (active) setAdminAuthReady(true); });
    const unsubscribe = watchAdminSession((session) => {
      if (active) {
        setAdminSession(session);
        setAdminAuthReady(true);
      }
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const cacheAge = Date.now() - showcaseCache.savedAt;
    const initialDelay = isShowcaseCacheFresh(showcaseCache)
      ? Math.max(0, EPISODE_REFRESH_INTERVAL_MS - cacheAge)
      : 0;
    const episodeSync = watchEpisodes(
      (supabaseEpisodes) => {
        const visibleEpisodes = filterEpisodesByAccess(supabaseEpisodes, accessTokenRef.current);
        setEpisodes(supabaseEpisodes);
        setEpisodeDetails((current) => Object.fromEntries(
          supabaseEpisodes.flatMap((summary) => {
            const details = current[summary.id];
            return details?.bodyLoaded
              ? [[summary.id, { ...summary, body: details.body, bodyLoaded: true }]]
              : [];
          }),
        ));
        setShowcaseCache(writeShowcaseCache(visibleEpisodes, accessTokenRef.current));
        setHasFreshData(true);
        setSupabaseLoading(false);
        setSupabaseError("");
      },
      () => {
        setSupabaseLoading(false);
        setSupabaseError("Supabase ne répond pas pour le moment. Une nouvelle tentative se fera automatiquement.");
      },
      { initialDelay },
    );
    refreshEpisodesRef.current = episodeSync.refresh;
    return () => {
      refreshEpisodesRef.current = null;
      episodeSync.unsubscribe();
    };
  }, []);
  useEffect(() => {
    const needsSkeleton = supabaseLoading && !hasFreshData && !cachedSorted.length && !adminOpen && view !== "about";
    if (!needsSkeleton) {
      setShowSkeleton(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), 200);
    return () => window.clearTimeout(timer);
  }, [adminOpen, cachedSorted.length, hasFreshData, supabaseLoading, view]);
  useEffect(() => {
    const detailedEpisode = episodeDetails[selectedId];
    if (view !== "episode" || !selectedSummary?.uid || detailedEpisode?.bodyLoaded) {
      return undefined;
    }

    let active = true;
    setDetailLoading(true);
    setDetailError("");
    loadSupabaseEpisodeDetails(selectedSummary)
      .then((episode) => {
        if (active) setEpisodeDetails((current) => ({ ...current, [episode.id]: episode }));
      })
      .catch((error) => {
        if (active) setDetailError(error?.message || "Chargement du contenu impossible.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [episodeDetails, selectedId, selectedSummary, view]);
  useEffect(() => {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([...bookmarks]));
  }, [bookmarks]);
  useEffect(() => {
    if (!hasFreshData) return;
    setBookmarks((current) => {
      const migrated = new Set();
      current.forEach((bookmarkId) => {
        const episode = episodes.find((item) => item.id === bookmarkId || item.legacyId === bookmarkId);
        if (episode) migrated.add(episode.id);
      });
      if (migrated.size === current.size && [...migrated].every((id) => current.has(id))) return current;
      return migrated;
    });
  }, [episodes, hasFreshData]);
  useEffect(() => {
    const handlePopState = () => {
      const route = readRoute();
      setView(route.view);
      setSelectedId(route.episodeId);
      setArchiveTag(route.tag);
      setAdminOpen(false);
      setAdminMarkdownOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  useEffect(() => {
    document.title = selected ? `TBA ${formatEpisodeNumber(selected.number)} — ${selected.title}` : "TBA Reader";
  }, [selected]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [view, selectedId, adminOpen]);
  const goTo = (next, episodeId = "", tag = "") => {
    const url = routeUrl(next, episodeId, tag);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({ tbaReader: true }, "", url);
    }
    setView(next);
    setSelectedId(episodeId);
    setArchiveTag(tag);
    setAdminOpen(false);
    setAdminMarkdownOpen(false);
  };
  const openEpisode = (episode) => goTo("episode", episode.id);
  const navigate = (next) => goTo(next);
  const changeAccessToken = (nextToken) => {
    accessTokenRef.current = nextToken;
    setAccessToken(nextToken);
    setEpisodeDetails({});
    setDetailError("");

    if (hasFreshData) {
      const visibleEpisodes = filterEpisodesByAccess(episodes, nextToken);
      setShowcaseCache(writeShowcaseCache(visibleEpisodes, nextToken));
    } else {
      setShowcaseCache(readShowcaseCache(nextToken));
      refreshEpisodesRef.current?.();
    }
  };
  const openAdmin = () => {
    setAdminMarkdownOpen(false);
    setAdminOpen(true);
  };
  const authenticateAdmin = async (pin) => {
    const session = await signInAdmin(pin);
    setAdminSession(session);
    return session;
  };
  const logoutAdmin = async () => {
    await signOutAdmin();
    setAdminSession(null);
    setAdminMarkdownOpen(false);
    setAdminOpen(false);
  };
  const openTag = (tag) => goTo("archive", "", tag);
  const changeArchiveTag = (tag) => goTo("archive", "", tag);
  const toggleBookmark = (id) => setBookmarks((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const loadEpisode = async (episode) => {
    const cachedDetails = episodeDetails[episode.id];
    if (cachedDetails?.bodyLoaded) return cachedDetails;
    const detailedEpisode = await loadSupabaseEpisodeDetails(episode);
    setEpisodeDetails((current) => ({ ...current, [detailedEpisode.id]: detailedEpisode }));
    return detailedEpisode;
  };
  const updateEpisodeList = (updateList) => setEpisodes((current) => {
    const next = updateList(current);
    setShowcaseCache(writeShowcaseCache(filterEpisodesByAccess(next, accessTokenRef.current), accessTokenRef.current));
    return next;
  });
  const saveEpisode = async (episode, files) => {
    const savedEpisode = await saveSupabaseEpisode(episode, files);
    updateEpisodeList((current) => {
      const exists = current.some((item) => item.uid === savedEpisode.uid);
      return exists
        ? current.map((item) => item.uid === savedEpisode.uid ? savedEpisode : item)
        : [...current, savedEpisode];
    });
    setEpisodeDetails((current) => ({ ...current, [savedEpisode.id]: savedEpisode }));
    return savedEpisode;
  };
  const deleteEpisode = async (episode) => {
    await removeSupabaseEpisode(episode);
    updateEpisodeList((current) => current.filter((item) => item.uid !== episode.uid));
    setEpisodeDetails((current) => {
      const next = { ...current };
      delete next[episode.id];
      return next;
    });
  };
  const renumberEpisodes = async () => {
    const result = await renumberSupabaseEpisodes();
    await refreshEpisodesRef.current?.();
    return result;
  };
  const migrateStorage = async (episode, target, onProgress) => {
    const migratedEpisode = await migrateEpisodeStorage(episode, target, onProgress);
    updateEpisodeList((current) => current.map((item) => item.uid === migratedEpisode.uid ? { ...item, ...migratedEpisode } : item));
    setEpisodeDetails((current) => current[migratedEpisode.id]
      ? { ...current, [migratedEpisode.id]: { ...current[migratedEpisode.id], ...migratedEpisode } }
      : current);
    return migratedEpisode;
  };
  const hasShowcaseData = sorted.length > 0;
  const showBlockingSupabaseError = Boolean(supabaseError) && !hasFreshData && !hasShowcaseData;
  const showSupabaseNotice = Boolean(supabaseError) && (hasFreshData || hasShowcaseData);
  const showInitialSkeleton = supabaseLoading && !hasFreshData && !hasShowcaseData;

  const readerView = () => {
    if (view === "about") {
      return <div className="reader-data">
        {supabaseError && <SupabaseNotice text={supabaseError}/>}
        <About accessToken={accessToken} onAccessTokenChange={changeAccessToken}/>
      </div>;
    }
    if (showBlockingSupabaseError) return <Empty title="Supabase indisponible" text={supabaseError}/>;
    if (showInitialSkeleton) return showSkeleton ? <LoadingSkeleton view={view}/> : <div className="loading-delay" aria-label="Chargement" aria-busy="true"/>;

    let content;
    if (view === "home") {
      content = <Home episode={sorted[0]} onOpen={openEpisode} onTag={openTag} bookmarks={bookmarks} onToggleBookmark={toggleBookmark}/>;
    } else if (view === "archive") {
      content = <Archive episodes={sorted.slice(1)} allTags={allTags} tag={archiveTag} setTag={changeArchiveTag} onOpen={openEpisode} bookmarks={bookmarks} onToggleBookmark={toggleBookmark}/>;
    } else if (view === "bookmarks") {
      content = <BookmarksPage episodes={bookmarkedEpisodes} onOpen={openEpisode} onTag={openTag} bookmarks={bookmarks} onToggleBookmark={toggleBookmark}/>;
    } else if (view === "episode" && detailError) {
      content = <Empty title="Contenu indisponible" text={detailError}/>;
    } else if (view === "episode" && selected?.cached && supabaseError && !selected.bodyLoaded) {
      content = <Empty title="Contenu indisponible" text="Le résumé enregistré reste disponible, mais Supabase doit répondre pour ouvrir le contenu complet."/>;
    } else if (view === "episode" && (detailLoading || (selected && !selected.bodyLoaded) || (supabaseLoading && !selected))) {
      content = <LoadingSkeleton view="episode"/>;
    } else if (view === "episode" && selected) {
      content = <EpisodePage episode={selected} onBack={() => navigate(selected.id === sorted[0]?.id ? "home" : "archive")} onTag={openTag} bookmarked={bookmarks.has(selected.id)} onToggleBookmark={toggleBookmark}/>;
    } else if (view === "episode") {
      content = <Empty title="TBA introuvable" text={`Aucun épisode ne correspond à l’identifiant ${selectedId}.`}/>;
    } else {
      content = <Home episode={sorted[0]} onOpen={openEpisode} onTag={openTag} bookmarks={bookmarks} onToggleBookmark={toggleBookmark}/>;
    }

    return <div className={`reader-data ${hasFreshData ? "is-fresh" : "is-cached"}`}>
      {supabaseLoading && !hasFreshData && hasShowcaseData && <div className="sync-progress" role="status"><span>Mise à jour des épisodes…</span><i/></div>}
      {showSupabaseNotice && <SupabaseNotice text={`${supabaseError}${hasShowcaseData ? " Le contenu enregistré reste consultable." : ""}`}/>}
      {content}
    </div>;
  };

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden="true"/>
      {!adminMarkdownOpen && <header className="site-header"><button className="brand" onClick={() => navigate("home")}><span>TBA</span><small>Thomas Bizarre Aventure</small></button><button className="admin-entry" onClick={adminOpen && adminSession ? logoutAdmin : openAdmin} aria-label={adminOpen && adminSession ? "Déconnexion" : "Espace créateur"}><Icon name="lock" size={16}/> {adminOpen && adminSession ? "Déconnexion" : "Créer"}</button></header>}
      <main>
        {adminOpen ? <Admin authReady={adminAuthReady} authenticated={Boolean(adminSession)} episodes={fullSorted} markdownOpen={adminMarkdownOpen} onMarkdownOpenChange={setAdminMarkdownOpen} onSave={saveEpisode} onDelete={deleteEpisode} onRenumber={renumberEpisodes} onSignIn={authenticateAdmin} onLoadEpisode={loadEpisode} onGetStorageStatus={getStorageStatus} onSaveStorageSettings={saveStorageSettings} onSetupR2={setupR2} onToggleR2={toggleR2} onChangePin={changeAdminPin} onMigrate={migrateStorage} onClose={() => { setAdminMarkdownOpen(false); setAdminOpen(false); }}/>
          : readerView()}
      </main>
      {!adminOpen && <footer><div className="footer-brand"><Icon name="lock" size={14}/> TBA Reader</div><span>© 2026 — Bizave Corp.</span></footer>}
      {!adminOpen && <nav className="bottom-nav" aria-label="Navigation principale">
        <button className={view === "home" ? "active" : ""} onClick={() => navigate("home")}><Icon name="home"/><span>Accueil</span></button>
        <button className={view === "archive" ? "active" : ""} onClick={() => navigate("archive")}><Icon name="grid"/><span>Listes</span></button>
        <button className={view === "bookmarks" ? "active" : ""} onClick={() => navigate("bookmarks")}><span className="nav-icon"><Icon name="bookmark"/>{bookmarks.size > 0 && <small>{bookmarks.size}</small>}</span><span>Signets</span></button>
        <button className={view === "about" ? "active" : ""} onClick={() => navigate("about")}><Icon name="info"/><span>À propos</span></button>
      </nav>}
    </div>
  );
}
