import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkAccent, remarkDividers, remarkSubtext } from "./markdown.js";

function normalizeMarkdownSource(value = "") {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let fence = null;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      output.push(line);
      return;
    }

    const standaloneSyntax = !fence && (/^-#[ \t]+\S/.test(line) || /^---(?:[ \t]+\S.*)?$/.test(line));
    if (!standaloneSyntax) {
      output.push(line);
      return;
    }

    if (output.length && output[output.length - 1] !== "") output.push("");
    output.push(line);
    if (index < lines.length - 1 && lines[index + 1] !== "") output.push("");
  });

  return output.join("\n");
}

function MarkdownImage({ src = "", alt = "", ...props }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [src]);

  if (missing || !src) {
    return <span className="markdown-image-missing" role="img" aria-label={alt || "Image introuvable"}>
      <span className="label">Image introuvable</span>
      <span className="alt">{alt || "Aucun texte alternatif — ajoute-le entre les crochets"}</span>
      {src && <span className="source">{src}</span>}
    </span>;
  }

  return <img src={src} alt={alt} onError={() => setMissing(true)} {...props}/>;
}

function MarkdownListItem({ node, className = "", ...props }) {
  const checkbox = node?.children?.find((child) => child.type === "element" && child.tagName === "input" && child.properties?.type === "checkbox");
  const taskClass = checkbox ? `markdown-task ${checkbox.properties.checked ? "done" : "todo"}` : "";
  return <li className={`${className} ${taskClass}`.trim()} {...props}/>;
}

export function MarkdownBody({ children = "", corsImages = false }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkAccent, remarkDividers, remarkSubtext]}
    components={{
      h1: ({ node, ...props }) => <h2 className="markdown-heading markdown-title-1" {...props}/>,
      h2: ({ node, ...props }) => <h3 className="markdown-heading markdown-title-2" {...props}/>,
      h3: ({ node, ...props }) => <h4 className="markdown-heading markdown-title-3" {...props}/>,
      h4: ({ node, ...props }) => <h5 className="markdown-heading markdown-title-4" {...props}/>,
      h5: ({ node, ...props }) => <h6 className="markdown-heading markdown-title-5" {...props}/>,
      h6: ({ node, ...props }) => <h6 className="markdown-heading markdown-title-6" {...props}/>,
      table: ({ node, ...props }) => <div className="markdown-table-wrap"><table {...props}/></div>,
      li: ({ node, ...props }) => <MarkdownListItem node={node} {...props}/>,
      input: ({ node, type, ...props }) => type === "checkbox" ? null : <input type={type} {...props}/>,
      img: ({ node, ...props }) => <MarkdownImage crossOrigin={corsImages ? "anonymous" : undefined} {...props}/>,
      a: ({ node, href = "", ...props }) => /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer" {...props}/>
        : <span className="markdown-link-disabled" {...props}/>,
    }}
  >
    {normalizeMarkdownSource(children)}
  </ReactMarkdown>;
}
