import React, { useEffect, useRef, useState } from "react";
import CodeMirror from "codemirror";
import "codemirror/lib/codemirror.css";
import "codemirror/addon/mode/overlay.js";
import "codemirror/addon/edit/continuelist.js";
import "codemirror/addon/display/placeholder.js";
import "codemirror/mode/xml/xml.js";
import "codemirror/mode/javascript/javascript.js";
import "codemirror/mode/css/css.js";
import "codemirror/mode/htmlmixed/htmlmixed.js";
import "codemirror/mode/markdown/markdown.js";
import { MarkdownBody } from "./MarkdownBody.jsx";
import "./MarkdownEditor.css";

if (!CodeMirror.modes["markdown-plus"]) {
  CodeMirror.defineMode("markdown-plus", (config) => {
    const overlay = {
      startState: () => ({ inHi: false, inSep: false, inSub: false }),
      copyState: (state) => ({ ...state }),
      token: (stream, state) => {
        if (stream.sol()) {
          state.inHi = false;
          state.inSep = false;
          state.inSub = false;
          if (stream.match(/^---[ \t]+(?=\S)/)) { state.inSep = true; return "sep-mark"; }
          if (stream.match(/^-#[ \t]+(?=\S)/)) { state.inSub = true; return "sub-mark"; }
        }
        if (state.inSep) { stream.skipToEnd(); state.inSep = false; return "sep"; }
        if (state.inSub) { stream.skipToEnd(); state.inSub = false; return "sub"; }
        if (state.inHi) {
          if (stream.match("==")) { state.inHi = false; return "hi-mark"; }
          while (stream.next() != null) if (stream.match("==", false)) break;
          return "hi";
        }
        if (stream.match("==")) {
          if (!stream.eol()) state.inHi = true;
          return "hi-mark";
        }
        while (stream.next() != null) if (stream.match("==", false)) break;
        return null;
      },
    };
    return CodeMirror.overlayMode(CodeMirror.getMode(config, {
      name: "markdown",
      highlightFormatting: true,
      fencedCodeBlockHighlighting: true,
    }), overlay);
  });
}

const GROUPS = {
  title: [
    { action: "h1", label: "Titre 1", hint: "#", className: "g1" },
    { action: "h2", label: "Titre 2", hint: "##", className: "g2" },
    { action: "h3", label: "Titre 3", hint: "###", className: "g3" },
    { action: "sub", label: "Sous-texte", hint: "-#", className: "gsub" },
  ],
  style: [
    { action: "bold", label: "Gras", hint: "**", className: "bo" },
    { action: "italic", label: "Italique", hint: "*", className: "it" },
    { action: "bolditalic", label: "Gras italique", hint: "***", className: "boit" },
    { action: "strike", label: "Barré", hint: "~~", className: "st" },
  ],
  list: [
    { action: "ul", label: "Liste à puces", hint: "-" },
    { action: "ol", label: "Liste numérotée", hint: "1." },
    { action: "task", label: "Case à cocher", hint: "- [ ]" },
  ],
  insert: [
    { action: "link", label: "Lien", hint: "[ ]( )" },
    { action: "image", label: "Image", hint: "![ ]( )" },
    { action: "table", label: "Tableau", hint: "| |" },
  ],
  accent: [
    { action: "hilite", label: "Texte accentué", hint: "== ==", className: "go" },
    { action: "quote", label: "Citation", hint: ">", className: "it" },
    { action: "seplabel", label: "Séparateur titré", hint: "--- titre" },
    { action: "hr", label: "Séparateur simple", hint: "---" },
  ],
  actions: [
    { action: "preview", label: "Prévisualiser le contenu", hint: "▶" },
    { action: "validate", label: "Enregistrer et revenir", hint: "✓", className: "go" },
    { action: "undo", label: "Annuler la dernière modification", hint: "↶" },
    { action: "clear", label: "Tout effacer", hint: "×" },
    { action: "exit", label: "Quitter sans enregistrer", hint: "←" },
  ],
};

const GROUP_BUTTONS = [
  { group: "title", label: "Titre", title: "Titres" },
  { group: "style", label: "Style", title: "Mise en forme du texte" },
  { group: "list", label: "Liste", title: "Listes et cases à cocher" },
  { group: "insert", label: "Insérer", title: "Lien, image, tableau" },
  { group: "accent", label: "Accent", title: "Citation, accentuation, séparateurs" },
];

export function MarkdownEditor({ value, onValidate, onCancel }) {
  const rootRef = useRef(null);
  const shellRef = useRef(null);
  const textareaRef = useRef(null);
  const editorRef = useRef(null);
  const pendingSelectionRef = useRef(null);
  const menuRefs = useRef({});
  const groupButtonRefs = useRef({});
  const toastTimerRef = useRef(null);
  const focusBeforePreviewRef = useRef(false);
  const keepCursorVisibleRef = useRef(() => {});
  const unlockScrollRef = useRef(() => {});
  const [count, setCount] = useState(0);
  const [openGroup, setOpenGroup] = useState("");
  const [menuPosition, setMenuPosition] = useState({ left: 8, down: false });
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState("");

  const showToast = (message) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 1500);
  };

  const closeMenu = (keepSelection = false) => {
    if (!keepSelection) pendingSelectionRef.current = null;
    setOpenGroup("");
  };

  const toggleMenu = (group) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (openGroup === group) {
      closeMenu();
      return;
    }
    if (window.matchMedia("(pointer: coarse)").matches) {
      if (!pendingSelectionRef.current) pendingSelectionRef.current = editor.listSelections();
      editor.setCursor(editor.getCursor("head"));
    }
    setOpenGroup(group);
    window.requestAnimationFrame(() => {
      const button = groupButtonRefs.current[group];
      const menu = menuRefs.current[group];
      const root = rootRef.current;
      if (!button || !menu || !root) return;
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const left = Math.max(8, Math.min(buttonRect.left - rootRect.left, rootRect.width - menuRect.width - 8));
      setMenuPosition({ left, down: buttonRect.top - rootRect.top < menuRect.height + 14 });
    });
  };

  const runAction = (action) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (pendingSelectionRef.current?.length) {
      editor.setSelections(pendingSelectionRef.current);
      pendingSelectionRef.current = null;
    }
    const hadFocus = editor.hasFocus();
    const wrap = (before, after = before, placeholder = "") => {
      const selection = editor.getSelection();
      if (selection) {
        if (selection.startsWith(before) && selection.endsWith(after)) {
          editor.replaceSelection(selection.slice(before.length, selection.length - after.length), "around");
        } else editor.replaceSelection(`${before}${selection}${after}`, "around");
        return;
      }
      const cursor = editor.getCursor();
      editor.replaceRange(`${before}${placeholder}${after}`, cursor);
      editor.setCursor({ line: cursor.line, ch: cursor.ch + before.length + placeholder.length });
    };
    const prefixLines = (makePrefix, matcher) => {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      let allHave = true;
      for (let lineNumber = from.line; lineNumber <= to.line; lineNumber += 1) {
        if (!matcher.test(editor.getLine(lineNumber))) { allHave = false; break; }
      }
      let number = 0;
      for (let lineNumber = from.line; lineNumber <= to.line; lineNumber += 1) {
        const line = editor.getLine(lineNumber);
        const next = allHave ? line.replace(matcher, "") : `${makePrefix(++number)}${line.replace(matcher, "")}`;
        editor.replaceRange(next, { line: lineNumber, ch: 0 }, { line: lineNumber, ch: line.length });
      }
    };
    const insertBlock = (text, caretBack = false) => {
      const cursor = editor.getCursor();
      const lead = editor.getLine(cursor.line).trim() ? "\n\n" : "";
      editor.replaceRange(`${lead}${text}\n`, cursor);
      if (caretBack) {
        const end = editor.getCursor();
        const line = Math.max(0, end.line - 1);
        editor.setCursor({ line, ch: editor.getLine(line).length });
      }
    };
    const levelPattern = /^(?:#{1,6}|-#)\s+/;
    const listPattern = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/;

    switch (action) {
      case "h1": prefixLines(() => "# ", levelPattern); break;
      case "h2": prefixLines(() => "## ", levelPattern); break;
      case "h3": prefixLines(() => "### ", levelPattern); break;
      case "sub": prefixLines(() => "-# ", levelPattern); break;
      case "bold": wrap("**", "**", "texte"); break;
      case "italic": wrap("*", "*", "texte"); break;
      case "bolditalic": wrap("***", "***", "texte"); break;
      case "strike": wrap("~~", "~~", "texte"); break;
      case "hilite": wrap("==", "==", "texte accentué"); break;
      case "ul": prefixLines(() => "- ", listPattern); break;
      case "ol": prefixLines((number) => `${number}. `, listPattern); break;
      case "task": prefixLines(() => "- [ ] ", listPattern); break;
      case "quote": prefixLines(() => "> ", /^>\s?/); break;
      case "link": wrap("[", "](https://)", editor.getSelection() ? "" : "texte du lien"); break;
      case "image": wrap("![", "](https://)", editor.getSelection() ? "" : "texte alternatif"); break;
      case "hr": insertBlock("---"); break;
      case "seplabel": insertBlock("--- titre de section", true); break;
      case "table": insertBlock("| Colonne | Colonne |\n|---|---|\n| Valeur | Valeur |\n| Valeur | Valeur |"); break;
      case "undo": editor.undo(); showToast("Annulé"); break;
      case "clear": {
        if (editor.getValue().length) {
          editor.replaceRange("", { line: 0, ch: 0 }, { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
          editor.setCursor(0, 0);
          showToast("Page vidée — annulable");
        }
        break;
      }
      case "preview":
        focusBeforePreviewRef.current = hadFocus;
        setPreview(editor.getValue());
        closeMenu();
        return;
      case "validate":
        closeMenu();
        onValidate(editor.getValue());
        return;
      case "exit":
        closeMenu();
        onCancel();
        return;
      default: return;
    }

    closeMenu();
    unlockScrollRef.current();
    keepCursorVisibleRef.current();
    if (hadFocus) editor.focus();
  };

  const closePreview = () => {
    setPreview(null);
    if (focusBeforePreviewRef.current) window.setTimeout(() => editorRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!openGroup) return undefined;
    const closeOutside = (event) => {
      if (!event.target.closest(".markdown-workshop-bar")) closeMenu();
    };
    const closeWithKeyboard = (event) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [openGroup]);

  useEffect(() => {
    if (preview === null) return undefined;
    const closeWithKeyboard = (event) => { if (event.key === "Escape") closePreview(); };
    document.addEventListener("keydown", closeWithKeyboard);
    return () => document.removeEventListener("keydown", closeWithKeyboard);
  }, [preview]);

  useEffect(() => {
    if (!textareaRef.current || !rootRef.current) return undefined;
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";

    const editor = CodeMirror.fromTextArea(textareaRef.current, {
      mode: "markdown-plus",
      theme: "atelier",
      lineWrapping: true,
      inputStyle: "contenteditable",
      spellcheck: true,
      autocorrect: true,
      placeholder: "Commence à écrire…",
      extraKeys: {
        Enter: "newlineAndIndentContinueMarkdownList",
        "Ctrl-B": () => runAction("bold"),
        "Cmd-B": () => runAction("bold"),
        "Ctrl-I": () => runAction("italic"),
        "Cmd-I": () => runAction("italic"),
        "Ctrl-K": () => runAction("link"),
        "Cmd-K": () => runAction("link"),
        "Ctrl-H": () => runAction("hilite"),
        "Cmd-H": () => runAction("hilite"),
      },
    });
    editorRef.current = editor;
    editor.setValue(value || "");
    editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length);

    const root = rootRef.current;
    const scroller = editor.getScrollerElement();
    const viewport = window.visualViewport || null;
    let lastHeight = -1;
    let lastTop = -1;
    let lockUntil = 0;
    let selfScroll = false;
    let touchActive = false;
    let scrollPending = false;
    let restMark = null;
    let destroyed = false;
    let touchFinishTimer = null;

    const lockScroll = (duration = 450) => { lockUntil = Math.max(lockUntil, Date.now() + duration); };
    const fit = (force = false) => {
      if (touchActive && !force) return;
      const height = Math.round(viewport ? viewport.height : window.innerHeight);
      const top = Math.round(viewport ? viewport.offsetTop : 0);
      if (!force && height === lastHeight && top === lastTop) return;
      const heightChanged = height !== lastHeight;
      lastHeight = height;
      lastTop = top;
      root.style.height = `${height}px`;
      root.style.top = `${top}px`;
      if (heightChanged || force) editor.refresh();
    };
    const keepCursorVisible = () => {
      if (Date.now() < lockUntil) return;
      const info = editor.getScrollInfo();
      const cursor = editor.cursorCoords(null, "local");
      const margin = 90;
      const viewBottom = info.top + info.clientHeight;
      if (cursor.top >= info.top + 12 && cursor.bottom <= viewBottom - margin) return;
      let target = cursor.bottom > viewBottom - margin ? cursor.bottom + margin - info.clientHeight : cursor.top - 12;
      target = Math.max(0, Math.min(target, Math.max(0, info.height - info.clientHeight)));
      if (Math.abs(target - info.top) < 2) return;
      selfScroll = true;
      editor.scrollTo(null, target);
      window.setTimeout(() => { selfScroll = false; }, 60);
    };
    keepCursorVisibleRef.current = keepCursorVisible;
    unlockScrollRef.current = () => { lockUntil = 0; };

    const clearRestCaret = () => {
      if (!restMark) return;
      try { restMark.clear(); } catch { /* marqueur déjà supprimé */ }
      restMark = null;
    };
    const showRestCaret = () => {
      clearRestCaret();
      if (editor.hasFocus() || destroyed) return;
      const marker = document.createElement("span");
      marker.className = "rest-caret";
      marker.setAttribute("aria-hidden", "true");
      restMark = editor.setBookmark(editor.getCursor(), { widget: marker, insertLeft: true });
    };
    const refreshCount = () => {
      const text = editor.getValue().trim();
      setCount(text ? text.split(/\s+/).length : 0);
    };
    const onChange = () => {
      refreshCount();
      if (scrollPending) return;
      scrollPending = true;
      window.requestAnimationFrame(() => {
        scrollPending = false;
        keepCursorVisible();
      });
    };
    const onScroll = () => { if (!selfScroll) lockScroll(450); };
    const onBlur = () => window.setTimeout(showRestCaret, 40);
    const onFocus = () => { clearRestCaret(); window.setTimeout(keepCursorVisible, 180); };
    const onCursorActivity = () => { if (!editor.hasFocus()) window.setTimeout(showRestCaret, 0); };
    const onTouchStart = () => { touchActive = true; lockScroll(700); };
    const onTouchMove = () => { touchActive = true; lockScroll(700); };
    const onTouchEnd = () => {
      touchActive = false;
      lockScroll(450);
      window.clearTimeout(touchFinishTimer);
      touchFinishTimer = window.setTimeout(() => fit(), 450);
    };
    const onViewportResize = () => {
      fit();
      if (!touchActive) lockUntil = 0;
      window.setTimeout(keepCursorVisible, 90);
    };
    const onViewportScroll = () => fit();
    const onOrientationChange = () => window.setTimeout(() => fit(true), 250);
    const onWindowResize = () => fit();
    const onShellMouseDown = (event) => {
      if (event.target !== shellRef.current) return;
      event.preventDefault();
      editor.focus();
      editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length);
    };

    editor.on("change", onChange);
    editor.on("scroll", onScroll);
    editor.on("blur", onBlur);
    editor.on("focus", onFocus);
    editor.on("cursorActivity", onCursorActivity);
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    shellRef.current.addEventListener("mousedown", onShellMouseDown);
    viewport?.addEventListener("resize", onViewportResize);
    viewport?.addEventListener("scroll", onViewportScroll);
    window.addEventListener("orientationchange", onOrientationChange);
    window.addEventListener("resize", onWindowResize);

    fit(true);
    refreshCount();
    window.setTimeout(showRestCaret, 120);
    document.fonts?.ready.then(() => { if (!destroyed) { editor.refresh(); fit(true); } });

    return () => {
      destroyed = true;
      window.clearTimeout(touchFinishTimer);
      clearRestCaret();
      editor.off("change", onChange);
      editor.off("scroll", onScroll);
      editor.off("blur", onBlur);
      editor.off("focus", onFocus);
      editor.off("cursorActivity", onCursorActivity);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      shellRef.current?.removeEventListener("mousedown", onShellMouseDown);
      viewport?.removeEventListener("resize", onViewportResize);
      viewport?.removeEventListener("scroll", onViewportScroll);
      window.removeEventListener("orientationchange", onOrientationChange);
      window.removeEventListener("resize", onWindowResize);
      editor.toTextArea();
      editorRef.current = null;
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  return <section className="markdown-workshop" ref={rootRef} aria-label="Éditeur du corps Markdown">
    <div className="markdown-workshop-shell" ref={shellRef}><textarea ref={textareaRef} aria-label="Corps Markdown"/></div>
    <div className="markdown-workshop-bar" onMouseDown={(event) => { if (event.target.closest("button")) event.preventDefault(); }}>
      <div className="markdown-workshop-tools">
        {GROUP_BUTTONS.map(({ group, label, title }) => <button
          className={`markdown-tool ${openGroup === group ? "open" : ""}`}
          type="button"
          title={title}
          aria-expanded={openGroup === group}
          ref={(node) => { groupButtonRefs.current[group] = node; }}
          onClick={() => toggleMenu(group)}
          key={group}
        >{label}<span className="caret">▾</span></button>)}
        <span className="markdown-word-count">{count} {count > 1 ? "mots" : "mot"}</span>
      </div>
      <div className="markdown-workshop-fixed-tools">
        <button
          className={`markdown-tool ${openGroup === "actions" ? "open" : ""}`}
          type="button"
          title="Options de l’éditeur"
          aria-label="Options de l’éditeur Markdown"
          aria-expanded={openGroup === "actions"}
          ref={(node) => { groupButtonRefs.current.actions = node; }}
          onClick={() => toggleMenu("actions")}
        >⋯</button>
      </div>
      {Object.entries(GROUPS).map(([group, actions]) => <div
        className={`markdown-popover ${openGroup === group ? "on" : ""} ${menuPosition.down ? "down" : ""}`}
        style={openGroup === group ? { left: menuPosition.left } : undefined}
        ref={(node) => { menuRefs.current[group] = node; }}
        key={group}
      >{actions.map((item) => <button type="button" onClick={() => runAction(item.action)} key={item.action}>
        <span className={item.className || ""}>{item.label}</span><span className="hint">{item.hint}</span>
      </button>)}</div>)}
    </div>

    {preview !== null && <div className="markdown-preview" role="dialog" aria-modal="true" aria-label="Aperçu du rendu">
      <header><span>Aperçu du rendu</span><button className="markdown-tool" type="button" onClick={closePreview}>Fermer</button></header>
      <div className="markdown-preview-scroll"><div className="markdown-preview-body">
        {preview.trim() ? <MarkdownBody>{preview}</MarkdownBody> : <p className="markdown-preview-empty">Rien à afficher pour l’instant.</p>}
      </div></div>
    </div>}
    <div className={`markdown-toast ${toast ? "on" : ""}`} role="status" aria-live="polite">{toast}</div>
  </section>;
}
