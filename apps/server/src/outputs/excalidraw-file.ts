// Board -> .excalidraw JSON (opens in excalidraw.com and any Excalidraw-based editor, fully editable).
import { Scene, type BoardFile } from "./scene";

export function sceneToExcalidraw(scene: Scene, files: Map<string, BoardFile>, opts: { viewBackgroundColor?: string } = {}) {
  const used = new Set(scene.fileIds());
  const fileMap: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {};
  for (const [id, f] of files) {
    if (used.has(id)) fileMap[id] = { id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created };
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "monet-blackboard",
    elements: scene.elements,
    appState: { viewBackgroundColor: opts.viewBackgroundColor ?? "#ffffff", gridSize: 20 },
    files: fileMap,
  };
}
