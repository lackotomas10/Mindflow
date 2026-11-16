const db = new Promise((resolve, reject) => {
  const request = indexedDB.open('mindflow', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('state');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function state(action, key, value) {
  return db.then((database) => new Promise((resolve, reject) => {
      const store = database.transaction('state', 'readwrite').objectStore('state');
      const request = action === 'put' ? store.put(value, key) : store[action](key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
}

const defaults = {
  theme: 'dark',
  accent: '#6c2dff',
  fontScale: 100,
  rememberWorkspace: true,
  showExtensions: true,
};

function getSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('mindflow.settings') || '{}') };
  } catch (error) {
    console.error(error);
    return { ...defaults };
  }
}

let settings = getSettings();

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--Highlight', settings.accent);
  document.documentElement.style.setProperty('--font-scale', settings.fontScale / 100);
}

function saveSettings() {
  localStorage.setItem('mindflow.settings', JSON.stringify(settings));
  applySettings();
}

function navigateToPage(url) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.location.href = url;
    return;
  }
  document.body.classList.add('page-leaving');
  window.setTimeout(() => {
    window.location.href = url;
  }, 140);
}

async function permission(handle, mode, ask) {
  let result = await handle.queryPermission({ mode });
  if (result !== 'granted' && ask) {
    result = await handle.requestPermission({ mode });
  }
  return result === 'granted';
}

async function chooseFolder(status, onChoose) {
  if (!window.showDirectoryPicker) {
    status.textContent = 'Choose a folder in Chrome or Edge to use browser file access.';
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (settings.rememberWorkspace) {
      await state('put', 'workspace', handle);
    }
    await onChoose(handle);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      status.textContent = `Could not open folder: ${error.message}`;
    }
  }
}

async function folderEntries(folder, path = '') {
  const entries = [];
  for await (const [name, handle] of folder.entries()) {
    const relativePath = path ? `${path}/${name}` : name;
    if (handle.kind === 'directory') {
      entries.push({ name, handle, path: relativePath, children: await folderEntries(handle, relativePath) });
    } else if (/\.md$/i.test(name)) {
      entries.push({ name, handle, path: relativePath });
    }
  }
  return entries.sort((a, b) => {
    if (Boolean(a.children) !== Boolean(b.children)) return a.children ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function openNote(note, workspace) {
  await state('put', 'note', {
    handle: note.handle,
    path: note.path,
    workspace: workspace.name,
    workspaceHandle: workspace,
  });
  navigateToPage('Mindflow.html');
}

function noteKey(path) {
  return path.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
}

function resolveLinkPath(sourcePath, target, availablePaths) {
  const cleanTarget = target.split('|')[0].split('#')[0].replace(/\\/g, '/');
  const base = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
  const targetPath = noteKey(`${base}${cleanTarget}`);
  const shortTarget = noteKey(cleanTarget);
  return availablePaths.has(targetPath)
    ? targetPath
    : availablePaths.has(shortTarget)
      ? shortTarget
      : [...availablePaths.keys()].find((path) => path.endsWith(`/${shortTarget}`));
}

function rewriteNoteLinks(content, sourcePath, availablePaths, renamedPaths, directoryMoved) {
  let linkCount = 0;

  function rewriteTarget(target) {
    const newPath = renamedPaths.get(resolveLinkPath(sourcePath, target, availablePaths));
    if (!newPath) return target;
    const fragmentIndex = target.indexOf('#');
    const path = fragmentIndex < 0 ? target : target.slice(0, fragmentIndex);
    const fragment = fragmentIndex < 0 ? '' : target.slice(fragmentIndex);
    const pathWithoutExtension = path.replace(/\.md$/i, '');
    const extension = /\.md$/i.test(path) ? '.md' : '';
    const renamedStem = newPath.replace(/\.md$/i, '');
    const replacement = directoryMoved
      ? `${renamedStem}${extension}`
      : `${pathWithoutExtension.includes('/')
        ? pathWithoutExtension.slice(0, pathWithoutExtension.lastIndexOf('/') + 1)
        : ''}${renamedStem.slice(renamedStem.lastIndexOf('/') + 1)}${extension}`;
    linkCount += 1;
    return `${replacement}${fragment}`;
  }

  const rewritten = content
    .replace(/\[\[([^\]]+)\]\]/g, (whole, inner) => {
      const aliasIndex = inner.indexOf('|');
      const target = aliasIndex < 0 ? inner : inner.slice(0, aliasIndex);
      const alias = aliasIndex < 0 ? '' : inner.slice(aliasIndex);
      return `[[${rewriteTarget(target)}${alias}]]`;
    })
    .replace(/\]\(([^)]+?\.md(?:#[^)]*)?)\)/gi, (whole, target) => `](${rewriteTarget(target)})`);

  return { content: rewritten, linkCount };
}

async function renameWorkspaceEntryAndLinks(entry, workspace, newName, isFolder, currentContent) {
  if (typeof entry.handle.move !== 'function') {
    throw new Error('Renaming is not supported by this browser.');
  }
  if (!(await permission(workspace, 'readwrite', true))) throw new Error('Write access denied');
  const files = await markdownFiles(workspace);
  const availablePaths = new Map(files.map((file) => [noteKey(file.path), file]));
  const parentPath = entry.path.includes('/')
    ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
    : '';
  const renamedEntryPath = `${parentPath}${newName}`;
  const renamedPaths = new Map();
  if (isFolder) {
    const oldPrefix = `${entry.path}/`;
    const newPrefix = `${renamedEntryPath}/`;
    files.forEach((file) => {
      if (file.path.startsWith(oldPrefix)) {
        renamedPaths.set(noteKey(file.path), `${newPrefix}${file.path.slice(oldPrefix.length)}`);
      }
    });
  } else {
    renamedPaths.set(noteKey(entry.path), renamedEntryPath);
  }

  const updates = [];
  let linkCount = 0;

  files.forEach((file) => {
    const result = rewriteNoteLinks(file.text, file.path, availablePaths, renamedPaths, isFolder);
    if (result.content !== file.text) {
      updates.push({ file, content: result.content });
      linkCount += result.linkCount;
    }
  });

  if (!(await permission(entry.handle, 'readwrite', true))) throw new Error('Write access denied');
  for (const { file } of updates) {
    if (file.path === entry.path) continue;
    if (!(await permission(file.handle, 'readwrite', true))) throw new Error('Write access denied');
  }
  await entry.handle.move(newName);

  let updatedFiles = 0;
  let warning;
  for (const { file, content } of updates) {
    try {
      const writable = await file.handle.createWritable();
      await writable.write(content);
      await writable.close();
      updatedFiles += 1;
    } catch (error) {
      warning =
        `Renamed the ${isFolder ? 'folder' : 'note'}, but updated links in only ${updatedFiles} of ${updates.length} files: ${error.message}`;
      break;
    }
  }

  const updatedCurrentContent = currentContent === undefined
    ? undefined
    : rewriteNoteLinks(currentContent, entry.path, availablePaths, renamedPaths, isFolder).content;
  return { linkCount, updatedCurrentContent, renamedEntryPath, warning };
}

async function renameEntry(entry, workspace, status, reload, isFolder) {
  const currentName = entry.handle.name;
  let newName = prompt(`Rename ${isFolder ? 'folder' : 'note'}:`, currentName);
  if (newName === null) return;
  newName = newName.trim();
  if (!newName || newName.includes('/') || newName.includes('\\')) {
    status.textContent = 'Enter a valid name without path separators.';
    return;
  }
  if (!isFolder && !/\.md$/i.test(newName)) newName += '.md';
  if (newName === currentName) return;

  try {
    let updatedLinks = 0;
    let warning;
    const result = await renameWorkspaceEntryAndLinks(entry, workspace, newName, isFolder);
    updatedLinks = result.linkCount;
    warning = result.warning;
    await reload(workspace);
    status.textContent = warning || (updatedLinks
      ? `Renamed ${newName} and updated ${updatedLinks} links.`
      : `Renamed ${newName}.`);
  } catch (error) {
    console.error(error);
    status.textContent = `Could not rename ${isFolder ? 'folder' : 'note'}: ${error.message}`;
  }
}

function showFolder(entries, parent, workspace, settings, loadWorkspace) {
  entries.forEach((entry) => {
    if (entry.children) {
      const folder = document.createElement('details');
      folder.className = 'tree-folder';
      const row = document.createElement('div');
      row.className = 'tree-folder-row';
      const summary = document.createElement('summary');
      summary.textContent = entry.name;
      const rename = document.createElement('button');
      rename.className = 'tree-rename button-secondary';
      rename.type = 'button';
      rename.textContent = 'Rename';
      rename.setAttribute('aria-label', `Rename folder ${entry.name}`);
      rename.addEventListener('click', () => renameEntry(
        entry,
        workspace,
        document.getElementById('StorageStatus'),
        loadWorkspace,
        true,
      ));
      const children = document.createElement('div');
      children.className = 'tree-children';
      showFolder(entry.children, children, workspace, settings, loadWorkspace);
      row.append(summary, rename);
      folder.append(row, children);
      parent.append(folder);
      return;
    }

    const row = document.createElement('div');
    row.className = 'tree-file-row';
    const open = document.createElement('button');
    open.className = 'tree-file';
    open.type = 'button';
    open.textContent = `▧ ${settings.showExtensions ? entry.name : entry.name.replace(/\.md$/i, '')}`;
    open.addEventListener('click', () => openNote(entry, workspace).catch((error) => {
      console.error(error);
      document.getElementById('StorageStatus').textContent = `Could not open note: ${error.message}`;
    }));
    const rename = document.createElement('button');
    rename.className = 'tree-rename button-secondary';
    rename.type = 'button';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename note ${entry.name}`);
    rename.addEventListener('click', () => renameEntry(
      entry,
      workspace,
      document.getElementById('StorageStatus'),
      loadWorkspace,
      false,
    ));
    row.append(open, rename);
    parent.append(row);
  });
}

function storagePage() {
  const status = document.getElementById('StorageStatus');
  const tree = document.getElementById('FolderTree');
  const name = document.getElementById('WorkspaceName');
  let workspace;

  async function loadWorkspace(handle) {
    if (!(await permission(handle, 'read', false))) {
      status.textContent = 'Access expired. Choose the folder again.';
      return;
    }
    workspace = handle;
    name.textContent = handle.name;
    tree.replaceChildren();
    const entries = await folderEntries(handle);
    showFolder(entries, tree, handle, settings, loadWorkspace);
    status.textContent = `${entries.length} items`;
  }

  document.getElementById('ChooseFolder').addEventListener('click', () => chooseFolder(status, loadWorkspace));
  document.getElementById('NewFolder').addEventListener('click', async () => {
    if (!workspace) {
      status.textContent = 'Open a workspace folder first.';
      return;
    }
    const folderName = prompt('New folder name:');
    if (!folderName) return;
    try {
      if (!(await permission(workspace, 'readwrite', true))) throw new Error('Write access denied');
      await workspace.getDirectoryHandle(folderName, { create: true });
      await loadWorkspace(workspace);
    } catch (error) {
      console.error(error);
      status.textContent = `Could not create folder: ${error.message}`;
    }
  });
  document.getElementById('NewNote').addEventListener('click', async () => {
    if (!workspace) {
      status.textContent = 'Open a workspace folder first.';
      return;
    }
    let fileName = prompt('New note name:');
    if (!fileName) return;
    fileName = fileName.trim();
    if (!fileName.endsWith('.md')) fileName += '.md';
    try {
      if (!(await permission(workspace, 'readwrite', true))) throw new Error('Write access denied');
      const handle = await workspace.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write('');
      await writable.close();
      await openNote({ handle, path: fileName }, workspace);
    } catch (error) {
      console.error(error);
      status.textContent = `Could not create note: ${error.message}`;
    }
  });

  state('get', 'workspace').then((handle) => {
    if (settings.rememberWorkspace && handle) loadWorkspace(handle).catch((error) => {
      console.error(error);
      status.textContent = `Could not load folder: ${error.message}`;
    });
  }).catch((error) => {
    console.error(error);
    status.textContent = 'Choose a workspace folder to get started.';
  });
}

function editorPage() {
  const text = document.getElementById('NoteText');
  const status = document.getElementById('NoteStatus');
  const save = document.getElementById('SaveNote');
  const clear = document.getElementById('DeleteNote');
  const rename = document.getElementById('RenameNote');
  const highlights = document.getElementById('NoteHighlight');
  let note;

  function renderHighlights() {
    highlights.replaceChildren();
    const pattern = /\[\[([^\]]+)\]\]/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text.value))) {
      highlights.append(document.createTextNode(text.value.slice(cursor, match.index)));
      const link = document.createElement('a');
      link.href = '#';
      link.dataset.target = match[1];
      link.tabIndex = -1;
      link.textContent = match[0];
      highlights.append(link);
      cursor = pattern.lastIndex;
    }
    highlights.append(document.createTextNode(text.value.slice(cursor)));
  }

  function show(handle, path, workspace, content, workspaceHandle) {
    note = { handle, path, workspace, workspaceHandle };
    text.value = content;
    document.getElementById('BoxName').textContent = path.includes('/')
      ? `${workspace}/${path.slice(0, path.lastIndexOf('/'))}`
      : workspace;
    document.getElementById('DocumentName').textContent = handle.name;
    document.title = `${handle.name} — Mindflow`;
    save.disabled = false;
    clear.disabled = false;
    rename.disabled = false;
    status.textContent = '';
    renderHighlights();
  }

  async function openLinkedNote(target) {
    if (!note || !note.workspaceHandle) {
      status.textContent = 'Open a note from a workspace to follow its links.';
      return;
    }
    const files = await markdownFiles(note.workspaceHandle);
    const available = new Map(files.map((file) => [noteKey(file.path), file]));
    const path = resolveLinkPath(note.path, target, available);
    const destination = available.get(path);
    if (!destination) {
      const cleanTarget = target.split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
      const targetPath = /\.md$/i.test(cleanTarget) ? cleanTarget : `${cleanTarget}.md`;
      const targetParts = targetPath.split('/');
      if (!cleanTarget || targetParts.some((part) => !part || part === '.' || part === '..')) {
        status.textContent = `Could not create linked note "${target.split('|')[0]}": enter a valid relative note path.`;
        return;
      }
      if (!(await permission(note.workspaceHandle, 'readwrite', true))) {
        throw new Error('Write access denied');
      }

      const parentPath = note.path.includes('/')
        ? note.path.slice(0, note.path.lastIndexOf('/'))
        : '';
      let directory = note.workspaceHandle;
      for (const part of parentPath.split('/').filter(Boolean)) {
        directory = await directory.getDirectoryHandle(part);
      }
      for (const part of targetParts.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      const handle = await directory.getFileHandle(targetParts[targetParts.length - 1], { create: true });
      await openNote({ handle, path: `${parentPath ? `${parentPath}/` : ''}${targetPath}` }, note.workspaceHandle);
      return;
    }
    await openNote(destination, note.workspaceHandle);
  }

  document.getElementById('OpenNote').addEventListener('click', async () => {
    if (!window.showOpenFilePicker) {
      status.textContent = 'Open Markdown files in Chrome or Edge.';
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown files', accept: { 'text/markdown': ['.md'] } }],
      });
      const file = await handle.getFile();
      await state('put', 'note', { handle, path: file.name, workspace: 'Local file' });
      show(handle, file.name, 'Local file', await file.text(), null);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        status.textContent = `Could not open note: ${error.message}`;
      }
    }
  });

  rename.addEventListener('click', async () => {
    let newName = prompt('Rename note:', note.handle.name);
    if (newName === null) return;
    newName = newName.trim();
    if (!newName || newName.includes('/') || newName.includes('\\')) {
      status.textContent = 'Enter a valid note name without path separators.';
      return;
    }
    if (!/\.md$/i.test(newName)) newName += '.md';
    if (newName === note.handle.name) return;
    try {
      let updatedLinks = 0;
      let updatedCurrentContent;
      let warning;
      let renamedPath;
      if (note.workspaceHandle) {
        const result = await renameWorkspaceEntryAndLinks(
          { handle: note.handle, path: note.path },
          note.workspaceHandle,
          newName,
          false,
          text.value,
        );
        updatedLinks = result.linkCount;
        updatedCurrentContent = result.updatedCurrentContent;
        renamedPath = result.renamedEntryPath;
        warning = result.warning;
      } else {
        if (!(await permission(note.handle, 'readwrite', true))) throw new Error('Write access denied');
        if (typeof note.handle.move !== 'function') {
          throw new Error('Renaming is not supported by this browser.');
        }
        await note.handle.move(newName);
      }
      if (renamedPath) {
        note.path = renamedPath;
      } else {
        const parentPath = note.path.includes('/')
          ? note.path.slice(0, note.path.lastIndexOf('/') + 1)
          : '';
        note.path = `${parentPath}${newName}`;
      }
      await state('put', 'note', note);
      document.getElementById('DocumentName').textContent = newName;
      document.title = `${newName} — Mindflow`;
      if (updatedCurrentContent !== undefined) {
        text.value = updatedCurrentContent;
        renderHighlights();
      }
      status.textContent = warning || (note.workspaceHandle
        ? `Renamed ${newName} and updated ${updatedLinks} links.`
        : `Renamed ${newName}; open it from a workspace to update its links.`);
    } catch (error) {
      console.error(error);
      status.textContent = `Could not rename note: ${error.message}`;
    }
  });

  text.addEventListener('input', renderHighlights);
  text.addEventListener('scroll', () => {
    highlights.scrollTop = text.scrollTop;
    highlights.scrollLeft = text.scrollLeft;
  });
  highlights.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-target]');
    if (!link) return;
    event.preventDefault();
    openLinkedNote(link.dataset.target).catch((error) => {
      console.error(error);
      status.textContent = `Could not open linked note: ${error.message}`;
    });
  });

  save.addEventListener('click', async () => {
    try {
      if (!(await permission(note.handle, 'readwrite', true))) throw new Error('Write access denied');
      const writable = await note.handle.createWritable();
      await writable.write(text.value);
      await writable.close();
      status.textContent = `Saved ${note.handle.name}`;
    } catch (error) {
      console.error(error);
      status.textContent = `Could not save note: ${error.message}`;
    }
  });

  clear.addEventListener('click', async () => {
    try {
      if (!(await permission(note.handle, 'readwrite', true))) throw new Error('Write access denied');
      const writable = await note.handle.createWritable();
      await writable.write('');
      await writable.close();
      text.value = '';
      renderHighlights();
      status.textContent = `Cleared ${note.handle.name}`;
    } catch (error) {
      console.error(error);
      status.textContent = `Could not clear note: ${error.message}`;
    }
  });

  state('get', 'note').then(async (saved) => {
    if (!saved) return;
    if (!(await permission(saved.handle, 'read', false))) {
      status.textContent = 'Open the note again to restore file access.';
      return;
    }
    const file = await saved.handle.getFile();
    show(saved.handle, saved.path, saved.workspace, await file.text(), saved.workspaceHandle);
  }).catch((error) => {
    console.error(error);
    status.textContent = `Could not restore note: ${error.message}`;
  });
}

async function markdownFiles(folder, path = '') {
  const files = [];
  for await (const [name, handle] of folder.entries()) {
    const relativePath = path ? `${path}/${name}` : name;
    if (handle.kind === 'directory') {
      files.push(...await markdownFiles(handle, relativePath));
    } else if (/\.md$/i.test(name)) {
      files.push({ name, path: relativePath, handle, text: await (await handle.getFile()).text() });
    }
  }
  return files;
}

function graphPositions(keys, edges) {
  const positions = new Map();
  if (!keys.length) return positions;

  const hashKey = (key) => {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
  };

  keys.forEach((key) => {
    const seed = hashKey(key);
    const randomX = ((Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const randomY = ((Math.imul(seed ^ 0x9e3779b9, 1664525) + 1013904223) >>> 0) / 4294967296;
    positions.set(key, { x: 120 + randomX * 760, y: 80 + randomY * 520 });
  });

  if (keys.length === 1) {
    positions.set(keys[0], { x: 500, y: 330 });
    return positions;
  }

  const indices = new Map(keys.map((key, index) => [key, index]));
  const links = [...edges].map((edge) => edge.split('|').map((key) => indices.get(key)))
    .filter(([from, to]) => from !== undefined && to !== undefined);
  const idealDistance = Math.sqrt((900 * 580) / keys.length);
  const iterations = Math.min(90, Math.max(24, Math.round(12000 / keys.length)));
  const initialTemperature = Math.max(4, idealDistance * 0.5);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = keys.map(() => ({ x: 0, y: 0 }));
    keys.forEach((key, firstIndex) => {
      const first = positions.get(key);
      for (let secondIndex = firstIndex + 1; secondIndex < keys.length; secondIndex += 1) {
        const second = positions.get(keys[secondIndex]);
        const dx = first.x - second.x;
        const dy = first.y - second.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = idealDistance * idealDistance / distance * 0.05;
        const forceX = dx / distance * force;
        const forceY = dy / distance * force;
        forces[firstIndex].x += forceX;
        forces[firstIndex].y += forceY;
        forces[secondIndex].x -= forceX;
        forces[secondIndex].y -= forceY;
      }
    });

    links.forEach(([from, to]) => {
      const first = positions.get(keys[from]);
      const second = positions.get(keys[to]);
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = distance * distance / idealDistance * 0.05;
      const forceX = dx / distance * force;
      const forceY = dy / distance * force;
      forces[from].x += forceX;
      forces[from].y += forceY;
      forces[to].x -= forceX;
      forces[to].y -= forceY;
    });

    const temperature = Math.max(0.35, initialTemperature * (1 - iteration / iterations));
    keys.forEach((key, index) => {
      const position = positions.get(key);
      const force = forces[index];
      force.x += (500 - position.x) * 0.3;
      force.y += (330 - position.y) * 0.3;
      const magnitude = Math.hypot(force.x, force.y);
      const movement = Math.min(magnitude, temperature);
      position.x = Math.max(36, Math.min(964, position.x + force.x / (magnitude || 1) * movement));
      position.y = Math.max(44, Math.min(626, position.y + force.y / (magnitude || 1) * movement));
    });
  }

  return positions;
}

function setGraphEdgePosition(edge, positions) {
  const first = positions.get(edge.dataset.from);
  const second = positions.get(edge.dataset.to);
  if (!first || !second) return;
  edge.setAttribute('x1', first.x);
  edge.setAttribute('y1', first.y);
  edge.setAttribute('x2', second.x);
  edge.setAttribute('y2', second.y);
}

function drawGraph(files, svg, workspace, status) {
  svg.replaceChildren();
  const positions = new Map();
  files.forEach((file, index) => {
    const key = noteKey(file.path);
    positions.set(key, {
      file,
      index,
    });
  });

  const edges = new Set();
  files.forEach((file) => {
    const links = file.text.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+\.md)(?:#[^)]*)?\)/gi);
    for (const match of links) {
      const destinationPath = resolveLinkPath(file.path, match[1] || match[2], positions);
      if (!destinationPath) continue;
      const sourcePath = noteKey(file.path);
      if (sourcePath !== destinationPath) edges.add([sourcePath, destinationPath].sort().join('|'));
    }
  });

  const layout = graphPositions([...positions.keys()], edges);
  positions.forEach((position, key) => Object.assign(position, layout.get(key)));

  edges.forEach((edge) => {
    const [from, to] = edge.split('|');
    const first = positions.get(from);
    const second = positions.get(to);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', first.x);
    line.setAttribute('y1', first.y);
    line.setAttribute('x2', second.x);
    line.setAttribute('y2', second.y);
    line.setAttribute('class', 'graph-edge');
    line.setAttribute('data-step', Math.max(first.index, second.index));
    line.setAttribute('data-from', from);
    line.setAttribute('data-to', to);
    svg.append(line);
  });

  const degrees = new Map([...positions.keys()].map((path) => [path, 0]));
  edges.forEach((edge) => {
    const [from, to] = edge.split('|');
    degrees.set(from, degrees.get(from) + 1);
    degrees.set(to, degrees.get(to) + 1);
  });

  positions.forEach(({ file, x, y, index }) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'graph-node');
    group.setAttribute('data-step', index);
    group.setAttribute('data-key', noteKey(file.path));
    group.setAttribute('data-final-x', x);
    group.setAttribute('data-final-y', y);
    group.setAttribute('transform', `translate(${x} ${y})`);
    const radius = 4 + Math.sqrt(degrees.get(noteKey(file.path))) * 15;
    group.setAttribute('data-final-radius', radius);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', radius);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('y', radius + 18);
    label.textContent = file.name.replace(/\.md$/i, '');
    group.append(circle, label);
    group.addEventListener('click', () => {
      openNote(file, workspace).catch((error) => {
        console.error(error);
        status.textContent = `Could not open note: ${error.message}`;
      });
    });
    svg.append(group);
  });
  return edges.size;
}

function chartsPage() {
  const status = document.getElementById('GraphStatus');
  const svg = document.getElementById('GraphCanvas');
  const animateButton = document.getElementById('AnimateGraph');
  let growthRun = 0;
  let graphSummary = '';

  function setNodeSize(node, radius) {
    const finalRadius = Number(node.dataset.finalRadius);
    node.querySelector('circle').style.transform = `scale(${radius / finalRadius})`;
    node.querySelector('text').style.transform = `translateY(${radius - finalRadius}px)`;
  }

  function finalPositions() {
    const positions = new Map();
    svg.querySelectorAll('.graph-node').forEach((node) => {
      positions.set(node.dataset.key, {
        x: Number(node.dataset.finalX),
        y: Number(node.dataset.finalY),
      });
    });
    return positions;
  }

  function resetGrowth() {
    growthRun += 1;
    svg.classList.remove('graph-growing');
    const positions = finalPositions();
    svg.querySelectorAll('.graph-node').forEach((node) => {
      node.classList.remove('is-visible');
      setNodeSize(node, Number(node.dataset.finalRadius));
      const position = positions.get(node.dataset.key);
      node.setAttribute('transform', `translate(${position.x} ${position.y})`);
    });
    svg.querySelectorAll('.graph-edge').forEach((edge) => {
      edge.classList.remove('is-visible');
      setGraphEdgePosition(edge, positions);
    });
    animateButton.disabled = svg.querySelectorAll('.graph-node').length === 0;
  }

  function moveToLayout(nodes, targets, positions, edges, run) {
    const starts = new Map(nodes.map((node) => [node.dataset.key, positions.get(node.dataset.key)]));
    const startTime = performance.now();
    const duration = 1200;

    return new Promise((resolve, reject) => {
      function frame(time) {
        if (run !== growthRun) {
          resolve();
          return;
        }

        try {
          const progress = Math.min(1, (time - startTime) / duration);
          const eased = progress * progress * progress
            * (progress * (progress * 6 - 15) + 10);
          nodes.forEach((node) => {
            const key = node.dataset.key;
            const start = starts.get(key);
            const target = targets.get(key);
            const position = {
              x: start.x + (target.x - start.x) * eased,
              y: start.y + (target.y - start.y) * eased,
            };
            positions.set(key, position);
            node.setAttribute('transform', `translate(${position.x} ${position.y})`);
          });
          edges.forEach((edge) => {
            if (edge.classList.contains('is-visible')) setGraphEdgePosition(edge, positions);
          });
          if (progress === 1) {
            resolve();
          } else {
            window.requestAnimationFrame(frame);
          }
        } catch (error) {
          reject(error);
        }
      }

      window.requestAnimationFrame(frame);
    });
  }

  async function animateGrowth() {
    const nodes = [...svg.querySelectorAll('.graph-node')];
    if (!nodes.length) return;

    const run = ++growthRun;
    const edges = [...svg.querySelectorAll('.graph-edge')];
    const nodesByKey = new Map(nodes.map((node) => [node.dataset.key, node]));
    svg.querySelectorAll('.is-visible').forEach((element) => element.classList.remove('is-visible'));
    svg.classList.add('graph-growing');
    const degrees = new Map(nodes.map((node) => [node.dataset.key, 0]));
    const animatedElements = nodes.flatMap((node) => [
      node.querySelector('circle'),
      node.querySelector('text'),
    ]);
    animatedElements.forEach((element) => {
      element.style.transition = 'none';
    });
    nodes.forEach((node) => setNodeSize(node, 4));
    svg.getBoundingClientRect();
    animatedElements.forEach((element) => element.style.removeProperty('transition'));
    animateButton.disabled = true;

    const activeNodes = [];
    const positions = new Map();
    for (let index = 0; index < nodes.length; index += 1) {
      if (run !== growthRun) return;
      const node = nodes[index];
      activeNodes.push(node);
      const key = node.dataset.key;
      const angle = Number(node.dataset.step) * 2.4;
      const offset = index === 0 ? 0 : Math.min(12, 4 + Math.sqrt(index) * 2);
      const start = {
        x: 500 + Math.cos(angle) * offset,
        y: 330 + Math.sin(angle) * offset,
      };
      positions.set(key, start);
      node.setAttribute('transform', `translate(${start.x} ${start.y})`);
      node.classList.add('is-visible');

      edges
        .filter((edge) => Number(edge.dataset.step) === index)
        .forEach((edge) => {
          edge.classList.add('is-visible');
          [edge.dataset.from, edge.dataset.to].forEach((nodeKey) => {
            const degree = degrees.get(nodeKey) + 1;
            degrees.set(nodeKey, degree);
            setNodeSize(nodesByKey.get(nodeKey), 4 + Math.sqrt(degree) * 15);
          });
          setGraphEdgePosition(edge, positions);
        });

      const activeKeys = new Set(activeNodes.map((activeNode) => activeNode.dataset.key));
      const activeEdges = new Set(edges
        .filter((edge) => activeKeys.has(edge.dataset.from) && activeKeys.has(edge.dataset.to))
        .map((edge) => `${edge.dataset.from}|${edge.dataset.to}`));
      const targets = graphPositions([...activeKeys], activeEdges);
      const growth = (index + 1) / nodes.length;
      const layoutScale = 0.18 + 0.82 * Math.pow(growth, 0.7);
      targets.forEach((target) => {
        target.x = 500 + (target.x - 500) * layoutScale;
        target.y = 330 + (target.y - 330) * layoutScale;
      });

      status.textContent = `Growing graph: ${index + 1} of ${nodes.length} notes`;
      await moveToLayout(activeNodes, targets, positions, edges, run);
      if (run !== growthRun) return;
      if (index < nodes.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    }

    svg.classList.remove('graph-growing');
    animateButton.disabled = false;
    status.textContent = graphSummary;
  }

  async function load(handle) {
    resetGrowth();
    animateButton.disabled = true;
    if (!(await permission(handle, 'read', false))) {
      animateButton.disabled = svg.querySelectorAll('.graph-node').length === 0;
      status.textContent = 'Access expired. Choose the workspace folder again.';
      return;
    }
    const files = await markdownFiles(handle);
    files.sort((first, second) => first.path.localeCompare(second.path));
    const edges = drawGraph(files, svg, handle, status);
    graphSummary = `${files.length} notes · ${edges} ${edges === 1 ? 'connection' : 'connections'}`;
    status.textContent = graphSummary;
    animateButton.disabled = files.length === 0;
  }

  animateButton.addEventListener('click', () => animateGrowth().catch((error) => {
    console.error(error);
    resetGrowth();
    status.textContent = `Could not animate graph: ${error.message}`;
  }));
  document.getElementById('ChooseGraphFolder').addEventListener('click', () => chooseFolder(status, load));
  document.getElementById('RefreshGraph').addEventListener('click', async () => {
    try {
      const handle = await state('get', 'workspace');
      if (!handle) {
        status.textContent = 'Choose a workspace folder first.';
        return;
      }
      await load(handle);
    } catch (error) {
      console.error(error);
      status.textContent = `Could not refresh graph: ${error.message}`;
    }
  });

  state('get', 'workspace').then((handle) => {
    if (handle) load(handle).catch((error) => {
      console.error(error);
      status.textContent = `Could not build graph: ${error.message}`;
    });
  }).catch((error) => {
    console.error(error);
    status.textContent = `Could not restore workspace: ${error.message}`;
  });
}

function settingsPage() {
  const theme = document.getElementById('ThemeSelect');
  const accent = document.getElementById('AccentColor');
  const size = document.getElementById('FontScale');
  const output = document.getElementById('FontScaleValue');
  const remember = document.getElementById('RememberWorkspace');
  const extensions = document.getElementById('ShowExtensions');
  const status = document.getElementById('SettingsStatus');

  theme.value = settings.theme;
  accent.value = settings.accent;
  size.value = settings.fontScale;
  output.value = `${settings.fontScale}%`;
  remember.checked = settings.rememberWorkspace;
  extensions.checked = settings.showExtensions;

  [theme, accent, size, remember, extensions].forEach((input) => {
    input.addEventListener('change', async () => {
      settings.theme = theme.value;
      settings.accent = accent.value;
      settings.fontScale = Number(size.value);
      settings.rememberWorkspace = remember.checked;
      settings.showExtensions = extensions.checked;
      saveSettings();
      output.value = `${settings.fontScale}%`;
      status.textContent = 'Settings saved.';
      if (!remember.checked) {
        try {
          await state('delete', 'workspace');
        } catch (error) {
          console.error(error);
          status.textContent = `Could not forget workspace: ${error.message}`;
        }
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  applySettings();
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.target || link.hasAttribute('download')) return;
    const destination = new URL(link.href, window.location.href);
    if (
      destination.protocol !== window.location.protocol
      || destination.host !== window.location.host
      || !/\.html$/i.test(destination.pathname)
      || destination.pathname === window.location.pathname
    ) return;
    event.preventDefault();
    navigateToPage(destination.href);
  });
  const page = document.body.dataset.page;
  if (page === 'editor') editorPage();
  if (page === 'storage') storagePage();
  if (page === 'charts') chartsPage();
  if (page === 'settings') settingsPage();
});
