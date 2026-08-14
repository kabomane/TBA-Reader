export function remarkAccent() {
  const transform = (node) => {
    if (!Array.isArray(node.children) || node.type === "code" || node.type === "inlineCode") return;

    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value.includes("==")) return [child];

      const parts = [];
      const pattern = /==([^=\n]+?)==/g;
      let cursor = 0;
      let match;

      while ((match = pattern.exec(child.value)) !== null) {
        if (match.index > cursor) {
          parts.push({ type: "text", value: child.value.slice(cursor, match.index) });
        }
        parts.push({
          type: "accent",
          data: { hName: "span", hProperties: { className: ["markdown-accent"] } },
          children: [{ type: "text", value: match[1] }],
        });
        cursor = pattern.lastIndex;
      }

      if (!parts.length) return [child];
      if (cursor < child.value.length) {
        parts.push({ type: "text", value: child.value.slice(cursor) });
      }
      return parts;
    });

    node.children.forEach(transform);
  };

  return transform;
}

function makeDivider(label) {
  const children = [];
  if (label) {
    children.push({
      type: "dividerLabel",
      data: { hName: "span" },
      children: [{ type: "text", value: label }],
    });
  }
  children.push({
    type: "dividerLine",
    data: { hName: "i" },
    children: [],
  });

  return {
    type: "tbaDivider",
    data: {
      hName: "div",
      hProperties: {
        className: ["content-divider", "markdown-divider", ...(label ? [] : ["is-empty"])],
        role: "separator",
        ariaLabel: label || "Séparateur",
      },
    },
    children,
  };
}

export function remarkDividers() {
  const transform = (node) => {
    if (!Array.isArray(node.children)) return;

    node.children = node.children.map((child) => {
      if (child.type === "thematicBreak") return makeDivider("");

      if (child.type === "paragraph" && child.children?.length === 1 && child.children[0].type === "text") {
        const match = child.children[0].value.match(/^---(.*)$/);
        if (match) return makeDivider(match[1].trim());
      }

      transform(child);
      return child;
    });
  };

  return transform;
}

export function remarkSubtext() {
  const transform = (node) => {
    if (!Array.isArray(node.children) || node.type === "code" || node.type === "inlineCode") return;

    node.children.forEach((child) => {
      if (child.type === "paragraph" && child.children?.[0]?.type === "text") {
        const match = child.children[0].value.match(/^-#[\t ]+/);
        if (match) {
          child.children[0].value = child.children[0].value.slice(match[0].length);
          child.data = {
            ...(child.data ?? {}),
            hName: "p",
            hProperties: { className: ["markdown-subtext"] },
          };
        }
      }
      transform(child);
    });
  };

  return transform;
}
