/** Recursive external folder scanning and structure-preserving import. */

export const IMPORTABLE_FILE_RE = /\.(pdf|pptx?)$/i;
export const MAX_FOLDER_IMPORT_DEPTH = 32;

const IGNORED_SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const IGNORED_DIRECTORIES = new Set(['__macosx', '.git']);

export function isImportableFileName(name) {
  const text = String(name || '');
  if (!text || text.startsWith('.')) return false;
  return IMPORTABLE_FILE_RE.test(text);
}

export function isIgnoredSystemFile(name) {
  const text = String(name || '');
  return !text || text.startsWith('.') || IGNORED_SYSTEM_FILES.has(text.toLowerCase());
}

export function isIgnoredDirectoryName(name) {
  const text = String(name || '');
  return !text || text.startsWith('.') || IGNORED_DIRECTORIES.has(text.toLowerCase());
}

export function sanitizeFolderSegment(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 80);
}

/**
 * Synchronously snapshot a DataTransfer during a drop event before any await
 * (browsers clear DataTransferItemList once the event turn yields).
 */
export function collectExternalDrop(dt) {
  const files = [];
  const dirs = [];
  let skippedFiles = 0;

  const items = dt ? Array.from(dt.items || []).filter((it) => it && it.kind === 'file') : [];
  if (items.length) {
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry) {
        if (entry.isDirectory) {
          if (!isIgnoredDirectoryName(entry.name)) dirs.push(entry);
        } else if (entry.isFile) {
          if (isImportableFileName(entry.name)) {
            const f = it.getAsFile?.();
            if (f) files.push(f);
          } else if (!isIgnoredSystemFile(entry.name)) {
            skippedFiles += 1;
          }
        }
        continue;
      }
      const f = it.getAsFile?.();
      if (!f) continue;
      if (isImportableFileName(f.name)) files.push(f);
      else if (!isIgnoredSystemFile(f.name)) skippedFiles += 1;
    }
    return { files, dirs, skippedFiles };
  }

  for (const f of Array.from(dt?.files || [])) {
    if (!f) continue;
    if (isImportableFileName(f.name)) files.push(f);
    else if (!isIgnoredSystemFile(f.name)) skippedFiles += 1;
  }
  return { files, dirs, skippedFiles };
}

async function readAllDirectoryEntries(dirEntry) {
  const reader = dirEntry.createReader();
  const entries = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch?.length) return entries;
    for (const entry of batch) entries.push(entry);
  }
}

function readFileEntry(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

const naturalCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * Recursively scan a FileSystemDirectoryEntry, keeping only importable files
 * and pruning subdirectories that contain no importable files anywhere inside.
 */
export async function scanDirectoryEntry(dirEntry, { maxDepth = MAX_FOLDER_IMPORT_DEPTH } = {}) {
  async function walk(entry, depth) {
    const node = {
      name: entry.name,
      files: [],
      children: [],
      totalFiles: 0,
      skippedFiles: 0,
      truncatedDirs: 0,
    };
    const entries = await readAllDirectoryEntries(entry);
    entries.sort((a, b) => naturalCompare(a?.name, b?.name));

    for (const en of entries) {
      if (!en) continue;
      if (en.isFile) {
        if (isImportableFileName(en.name)) {
          const f = await readFileEntry(en);
          if (f) {
            node.files.push(f);
            node.totalFiles += 1;
          } else {
            node.skippedFiles += 1;
          }
        } else if (!isIgnoredSystemFile(en.name)) {
          node.skippedFiles += 1;
        }
      } else if (en.isDirectory) {
        if (isIgnoredDirectoryName(en.name)) continue;
        if (depth >= maxDepth) {
          node.truncatedDirs += 1;
          continue;
        }
        const child = await walk(en, depth + 1);
        node.skippedFiles += child.skippedFiles;
        node.truncatedDirs += child.truncatedDirs;
        if (child.totalFiles > 0) {
          node.children.push(child);
          node.totalFiles += child.totalFiles;
        }
      }
    }
    return node;
  }

  return walk(dirEntry, 0);
}

/**
 * Build pruned directory trees from File objects that carry webkitRelativePath
 * (e.g. from <input webkitdirectory>).
 */
export function buildTreesFromRelativeFiles(fileList) {
  const roots = new Map();
  let skippedFiles = 0;

  const getOrCreateChild = (map, name) => {
    let node = map.get(name);
    if (!node) {
      node = { name, files: [], childrenMap: new Map(), skippedFiles: 0, truncatedDirs: 0 };
      map.set(name, node);
    }
    return node;
  };

  for (const file of Array.from(fileList || [])) {
    if (!file) continue;
    const rel = String(file.webkitRelativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    if (dirParts.some(isIgnoredDirectoryName)) continue;
    if (!isImportableFileName(fileName)) {
      if (!isIgnoredSystemFile(fileName)) skippedFiles += 1;
      continue;
    }
    let current = getOrCreateChild(roots, dirParts[0]);
    for (let i = 1; i < dirParts.length; i += 1) {
      current = getOrCreateChild(current.childrenMap, dirParts[i]);
    }
    current.files.push(file);
  }

  const finalize = (raw) => {
    const files = raw.files.slice().sort((a, b) => naturalCompare(a.name, b.name));
    const children = [...raw.childrenMap.values()]
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map(finalize)
      .filter((c) => c.totalFiles > 0);
    const totalFiles = files.length + children.reduce((sum, c) => sum + c.totalFiles, 0);
    return {
      name: raw.name,
      files,
      children,
      totalFiles,
      skippedFiles: 0,
      truncatedDirs: 0,
    };
  };

  const trees = [...roots.values()]
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map(finalize)
    .filter((t) => t.totalFiles > 0);
  if (trees.length && skippedFiles) trees[0].skippedFiles += skippedFiles;
  return { trees, skippedFiles };
}

/**
 * Materialize a scanned directory tree in the library and enqueue all importable files
 * into their corresponding nested folders.
 */
export async function importScannedFolderTree(
  tree,
  parentFolder,
  { createFolder, enqueueFiles, onFolderCreated = () => {} },
) {
  if (!tree || tree.totalFiles === 0) {
    return {
      rootPath: '',
      createdFolders: [],
      queuedFiles: 0,
      skippedFiles: tree?.skippedFiles || 0,
      truncatedDirs: tree?.truncatedDirs || 0,
      empty: true,
      failedFolders: [],
    };
  }

  const createdFolders = [];
  const failedFolders = [];
  let queuedFiles = 0;

  async function materialize(node, currentParent) {
    const safeName = sanitizeFolderSegment(node.name);
    if (!safeName) {
      failedFolders.push({ name: node.name, reason: 'invalid-name', error: '' });
      return '';
    }
    let folderPath = '';
    try {
      folderPath = await createFolder(safeName, currentParent);
    } catch (err) {
      failedFolders.push({ name: safeName, reason: 'create-failed', error: err?.message || String(err) });
      return '';
    }
    if (!folderPath) {
      failedFolders.push({ name: safeName, reason: 'create-failed', error: 'empty folder path' });
      return '';
    }
    createdFolders.push(folderPath);
    onFolderCreated(folderPath);

    if (node.files.length) {
      await enqueueFiles(node.files, folderPath);
      queuedFiles += node.files.length;
    }
    for (const child of node.children) {
      await materialize(child, folderPath);
    }
    return folderPath;
  }

  const rootPath = await materialize(tree, parentFolder || '');
  return {
    rootPath,
    createdFolders,
    queuedFiles,
    skippedFiles: tree.skippedFiles || 0,
    truncatedDirs: tree.truncatedDirs || 0,
    empty: false,
    failedFolders,
  };
}
