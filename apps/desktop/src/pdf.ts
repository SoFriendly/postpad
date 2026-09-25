// Minimal PDF writer: one US-Letter page of text in the PDF built-in fonts, so the
// box-key printout needs no dependency. ASCII only (built-in fonts, no embedding).
// ponytail: no QR code yet; add one when "scan to open on your phone" is wanted.

type Font = "F1" | "F2" | "F3"; // Helvetica, Helvetica-Bold, Courier
export type Line = { text: string; font?: Font; size?: number; gap?: number };

const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");

// Greedy word wrap for a ~500pt text column. Courier is 0.6em per char; Helvetica averages ~0.5em.
function wrap(text: string, font: Font, size: number): string[] {
  const max = Math.floor(500 / (size * (font === "F3" ? 0.6 : 0.5)));
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = word;
  }
  return [...out, cur];
}

export function textPdf(lines: Line[]): Uint8Array {
  const ops: string[] = [];
  let y = 750;
  for (const { text, font = "F1", size = 11, gap = 0 } of lines) {
    y -= gap;
    for (const part of wrap(text, font, size)) {
      y -= size * 1.4;
      ops.push(`BT /${font} ${size} Tf 56 ${y.toFixed(1)} Td (${esc(part)}) Tj ET`);
    }
  }
  const content = ops.join("\n");
  const font = (name: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>",
    font("Helvetica"), font("Helvetica-Bold"), font("Courier"),
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  // Everything is ASCII, so string offsets are byte offsets for the xref table.
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** The printout you keep: the key, where it works, and why it matters. */
export function boxKeyPdf(key: string, postOffice: string, opened = new Date()): Uint8Array {
  const half = Math.ceil(key.length / 2);
  return textPdf([
    { text: "PostPad", font: "F2", size: 24 },
    { text: "Your PO Box key", font: "F2", size: 16, gap: 4 },
    { text: "Keep this page somewhere safe: a password manager, or a drawer at home.", gap: 6 },
    { text: "BOX KEY", font: "F2", size: 9, gap: 18 },
    { text: key.slice(0, half), font: "F3", size: 14, gap: 2 },
    { text: key.slice(half), font: "F3", size: 14 },
    { text: "(Type it as one line; the line break and spaces don't matter.)", size: 9, gap: 2 },
    { text: `Post office: ${postOffice}`, gap: 14 },
    { text: `Opened: ${opened.toISOString().slice(0, 10)}` },
    { text: "What this key is for", font: "F2", size: 13, gap: 22 },
    { text: "PostPad has no accounts. This key is the only way into your PO Box. You need it to open the same box on another device (your phone, another computer, your widgets) and to get back in after reinstalling PostPad." },
    { text: "To open your box on another device", font: "F2", size: 13, gap: 16 },
    { text: "1. Install PostPad and choose \"I have a box key\"." },
    { text: `2. Enter the key above. If your post office isn't ${postOffice}, set it under "Post office" first.` },
    { text: "Keep it private", font: "F2", size: 13, gap: 16 },
    { text: "Anyone with this key can read and manage your pad. PostPad can't recover a lost key. If you lose it, open a new PO Box and point your senders at the new delivery addresses." },
  ]);
}
