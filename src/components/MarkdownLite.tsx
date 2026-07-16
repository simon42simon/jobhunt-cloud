// Deliberately tiny Markdown renderer: enough to make a job file's body and
// gaps checklist readable in the drawer without pulling in a full MD library.
// Editing of that content still happens in Obsidian (the source of truth).

function renderInline(text: string, keyPrefix: string) {
  // Strip wikilinks [[a|b]] -> b, [[a]] -> a; render **bold** and `code`.
  let t = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(t))) {
    if (m.index > last) parts.push(t.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**"))
      parts.push(<strong key={`${keyPrefix}-${i}`} className="text-[var(--color-text)]">{tok.slice(2, -2)}</strong>);
    else
      parts.push(
        <code key={`${keyPrefix}-${i}`} className="rounded bg-[var(--color-panel-2)] px-1 py-0.5 text-[12px] text-[#a5b4fc]">
          {tok.slice(1, -1)}
        </code>
      );
    last = m.index + tok.length;
    i++;
  }
  if (last < t.length) parts.push(t.slice(last));
  return parts;
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  return (
    <div className="space-y-1 text-[13px] leading-relaxed text-[var(--color-muted)]">
      {lines.map((line, idx) => {
        const key = `l${idx}`;
        if (!line.trim()) return <div key={key} className="h-2" />;
        if (line.startsWith("# "))
          return <h3 key={key} className="pt-1 text-[15px] font-semibold text-[var(--color-text)]">{renderInline(line.slice(2), key)}</h3>;
        if (line.startsWith("## "))
          return <h4 key={key} className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-[#9aa6bd]">{renderInline(line.slice(3), key)}</h4>;
        const cb = line.match(/^\s*-\s\[( |x|X)\]\s(.*)$/);
        if (cb)
          return (
            <div key={key} className="flex items-start gap-2 pl-1">
              <span
                className={`mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                  cb[1].toLowerCase() === "x"
                    ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                    : "border-[var(--color-edge)]"
                }`}
              >
                {cb[1].toLowerCase() === "x" ? "✓" : ""}
              </span>
              <span>{renderInline(cb[2], key)}</span>
            </div>
          );
        const bullet = line.match(/^\s*-\s(.*)$/);
        if (bullet)
          return (
            <div key={key} className="flex gap-2 pl-1">
              <span className="text-[#7c88a4]">•</span>
              <span>{renderInline(bullet[1], key)}</span>
            </div>
          );
        return <p key={key}>{renderInline(line, key)}</p>;
      })}
    </div>
  );
}
