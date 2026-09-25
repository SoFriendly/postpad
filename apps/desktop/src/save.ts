// Save a file the user keeps (box key PDF, PO Box file). In the Tauri app: the native
// save dialog, then write the chosen path (plain browser downloads don't work in Tauri
// webviews on macOS/iOS/Android). In a browser (vite dev): a normal download.
import { isTauri } from "@tauri-apps/api/core";

/** Returns false if the user cancelled the save dialog. */
export async function saveFile(name: string, data: Uint8Array, mime: string): Promise<boolean> {
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const ext = name.split(".").pop()!;
    const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return false;
    await writeFile(path, data); // the dialog adds the chosen path to the fs scope
    return true;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
