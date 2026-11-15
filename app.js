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
  });
  window.location.href = 'Mindflow.html';
}

function showFolder(entries, parent, workspace, settings) {
  entries.forEach((entry) => {
    if (entry.children) {
      const folder = document.createElement('details');
      folder.className = 'tree-folder';
      const summary = document.createElement('summary');
      summary.textContent = entry.name;
      const children = document.createElement('div');
      children.className = 'tree-children';
      showFolder(entry.children, children, workspace, settings);
      folder.append(summary, children);
      parent.append(folder);
      return;
    }

    const button = document.createElement('button');
    button.className = 'tree-file';
    button.type = 'button';
    button.textContent = `▧ ${settings.showExtensions ? entry.name : entry.name.replace(/\.md$/i, '')}`;
    button.addEventListener('click', () => openNote(entry, workspace).catch((error) => {
      console.error(error);
      document.getElementById('StorageStatus').textContent = `Could not open note: ${error.message}`;
    }));
    parent.append(button);
  });
}

function storagePage() {
  const status = document.getElementById('StorageStatus');
  const tree = document.getElementById('FolderTree');
  const name = document.getElementById('WorkspaceName');
  let workspace;

  async function load(handle) {
    if (!(await permission(handle, 'read', false))) {
      status.textContent = 'Access expired. Choose the folder again.';
      return;
    }
    workspace = handle;
    name.textContent = handle.name;
    tree.replaceChildren();
    const entries = await folderEntries(handle);
    showFolder(entries, tree, handle, settings);
    status.textContent = `${entries.length} items`;
  }

  document.getElementById('ChooseFolder').addEventListener('click', () => chooseFolder(status, load));
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
      await load(workspace);
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
    if (settings.rememberWorkspace && handle) load(handle).catch((error) => {
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
  let note;

  function show(handle, path, workspace, content) {
    note = { handle, path, workspace };
    text.value = content;
    document.getElementById('BoxName').textContent = path.includes('/')
      ? `${workspace}/${path.slice(0, path.lastIndexOf('/'))}`
      : workspace;
    document.getElementById('DocumentName').textContent = handle.name;
    document.getElementById('DocumentHeadline').textContent = handle.name;
    document.title = `${handle.name} — Mindflow`;
    save.disabled = false;
    clear.disabled = false;
    status.textContent = path;
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
      show(handle, file.name, 'Local file', await file.text());
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        status.textContent = `Could not open note: ${error.message}`;
      }
    }
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
    show(saved.handle, saved.path, saved.workspace, await file.text());
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

function drawGraph(files, svg, workspace) {
  svg.replaceChildren();
  const positions = new Map();
  const noteKey = (path) => path.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
  const centerX = 500;
  const centerY = 330;
  const radius = Math.min(250, 90 + Math.sqrt(files.length) * 17);
  files.forEach((file, index) => {
    const angle = files.length === 1 ? 0 : (2 * Math.PI * index / files.length) - Math.PI / 2;
    positions.set(noteKey(file.path), {
      file,
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    });
  });

  const edges = new Set();
  files.forEach((file) => {
    const links = file.text.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)]+\.md)(?:#[^)]*)?\)/gi);
    for (const match of links) {
      const target = (match[1] || match[2]).split('|')[0].split('#')[0].replace(/\\/g, '/');
      const base = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
      const targetPath = noteKey(`${base}${target}`);
      const shortTarget = noteKey(target);
      const destinationPath = positions.has(targetPath)
        ? targetPath
        : positions.has(shortTarget)
          ? shortTarget
          : [...positions.keys()].find((path) => path.endsWith(`/${shortTarget}`));
      if (!destinationPath) continue;
      const sourcePath = noteKey(file.path);
      if (sourcePath !== destinationPath) edges.add([sourcePath, destinationPath].sort().join('|'));
    }
  });

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
    svg.append(line);
  });

  positions.forEach(({ file, x, y }) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'graph-node');
    group.setAttribute('transform', `translate(${x} ${y})`);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '8');
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('y', '26');
    label.textContent = file.name.replace(/\.md$/i, '');
    group.append(circle, label);
    group.addEventListener('click', async () => {
      await state('put', 'note', { handle: file.handle, path: file.path, workspace: workspace.name });
      window.location.href = 'Mindflow.html';
    });
    svg.append(group);
  });
  return edges.size;
}

function chartsPage() {
  const status = document.getElementById('GraphStatus');
  const svg = document.getElementById('GraphCanvas');

  async function load(handle) {
    if (!(await permission(handle, 'read', false))) {
      status.textContent = 'Access expired. Choose the workspace folder again.';
      return;
    }
    const files = await markdownFiles(handle);
    const edges = drawGraph(files, svg, handle);
    status.textContent = `${files.length} notes · ${edges} connections`;
  }

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
  const page = document.body.dataset.page;
  if (page === 'editor') editorPage();
  if (page === 'storage') storagePage();
  if (page === 'charts') chartsPage();
  if (page === 'settings') settingsPage();
});
