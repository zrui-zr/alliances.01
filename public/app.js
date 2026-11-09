const socket = io();

const state = {
  player: null,
  players: [],
  settings: {},
  boardSize: 15,
  mode: 'test',
  serverRestartManaged: false,
  actionMode: null,
  selectedTile: null
};

const DISPLAY_RANGE = 3;
let adminFormDirty = false;
let profileFormDirty = false;

const boardEl = document.getElementById('board');
const statusBox = document.getElementById('statusBox');
const playerBadge = document.getElementById('playerBadge');
const playerListEl = document.getElementById('playerList');
const privateStateEl = document.getElementById('privateState');
const modeLabel = document.getElementById('modeLabel');
const adminPanel = document.getElementById('adminPanel');
const toastEl = document.getElementById('toast');

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const profileForm = document.getElementById('profileForm');
const passwordForm = document.getElementById('passwordForm');
const adminForm = document.getElementById('adminForm');
const playerActions = document.getElementById('playerActions');
const moveControls = document.getElementById('moveControls');
const attackControls = document.getElementById('attackControls');
const rangeControls = document.getElementById('rangeControls');
const giveApControls = document.getElementById('giveApControls');
const npcPlacementControls = document.getElementById('npcPlacementControls');
const npcMoveControls = document.getElementById('npcMoveControls');

function isSameTile(tile, x, y) {
  return Boolean(tile && tile.x === x && tile.y === y);
}

function cancelAction() {
  state.actionMode = null;
  state.selectedTile = null;
  state.selectedTargetId = null;
  state.selectedNpcId = null;
  renderAll();
}

function setActionMode(mode) {
  state.actionMode = mode;
  state.selectedTile = null;
  state.selectedTargetId = null;
  renderAll();
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  toastEl.style.borderLeftColor = isError ? '#ff5c7c' : '#5ef2c6';
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}

function updateAuthVisibility() {
  const loggedIn = Boolean(state.player);
  document.getElementById('authSection').classList.toggle('hidden', loggedIn);
  document.getElementById('logoutWrap').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    playerBadge.textContent = `${state.player.displayName} (${state.player.role})`;
    if (!profileFormDirty) {
      document.getElementById('profileDisplayName').value = state.player.displayName;
      document.getElementById('profileCountry').value = state.player.country || 'US';
    }
  } else {
    playerBadge.textContent = 'Not logged in';
  }
  adminPanel.classList.toggle('hidden', !(loggedIn && state.player.role === 'admin'));
}

function renderStatus() {
  const turnAt = new Date(state.settings.nextTurnAt || Date.now());
  const gameStatus = !state.settings.started
    ? 'Not started'
    : state.settings.paused
      ? 'Paused'
      : 'Running';
  statusBox.innerHTML = `
    <div>Mode: ${state.mode.toUpperCase()}</div>
    <div>Game: ${gameStatus}</div>
    <div>Next turn: ${state.settings.started ? turnAt.toLocaleTimeString() : 'Waiting for admin'}</div>
    <div>Interval: ${state.settings.turnIntervalMs || 30000} ms</div>
    <div>Action window: ${state.settings.actionWindowMs || 15000} ms</div>
    <div>AP per turn: ${state.settings.apPerTurn || 1}</div>
  `;
}

function renderPlayerList() {
  playerListEl.innerHTML = '';
  state.players.forEach((player) => {
    const li = document.createElement('li');
    const aliveLabel = player.alive ? 'Alive' : 'Eliminated';
    const typeLabel = player.isNpc ? 'NPC' : aliveLabel;
    li.textContent = `${player.displayName} — ${typeLabel} @ ${player.x},${player.y}`;
    playerListEl.appendChild(li);
  });
}

function renderPrivateState() {
  if (!state.player) {
    privateStateEl.textContent = 'Login to see private information.';
    return;
  }

  const activePlayer = state.players.find((p) => p.id === state.player.id) || state.player;
  privateStateEl.innerHTML = `
    <div>Username: ${state.player.username}</div>
    <div>Display name: ${state.player.displayName}</div>
    <div>Country: ${state.player.country || 'US'}</div>
    <div>Position: ${activePlayer.x}, ${activePlayer.y}</div>
    <div>Hearts: ${activePlayer.hearts || 0}</div>
    <div>AP: ${activePlayer.ap || 0}</div>
    <div>Attack range: ${1 + Number(state.player.rangeLevel || 0)}</div>
    <div>Role: ${state.player.role}</div>
  `;
}

function renderBoard() {
  boardEl.innerHTML = '';
  const activePlayer = state.actionMode === 'npc-move'
    ? state.players.find((player) => player.id === state.selectedNpcId)
    : state.player
      ? state.players.find((player) => player.id === state.player.id) || state.player
      : null;

  for (let y = 0; y < state.boardSize; y += 1) {
    for (let x = 0; x < state.boardSize; x += 1) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.type = 'button';
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);

      const occupant = state.players.find((player) => player.alive && player.x === x && player.y === y);
      const distance = activePlayer ? Math.abs(activePlayer.x - x) + Math.abs(activePlayer.y - y) : Infinity;
      const adjacent = activePlayer
        && Math.max(Math.abs(activePlayer.x - x), Math.abs(activePlayer.y - y)) === 1;
      const empty = !occupant;
      const inRange = activePlayer
        && distance <= DISPLAY_RANGE;
      const attackable = state.player && occupant && occupant.id !== state.player.id
        && distance <= 1 + Number(state.player.rangeLevel || 0);
      const moveTarget = state.actionMode === 'move' && adjacent && empty;
      const attackTarget = state.actionMode === 'attack' && Boolean(attackable);
      const npcTarget = state.actionMode === 'npc-placement' && empty;
      const npcMoveTarget = state.actionMode === 'npc-move' && adjacent && empty;
      const currentAttackRange = 1 + Number(state.player?.rangeLevel || 0);
      const rangePreview = state.actionMode === 'range'
        && distance > currentAttackRange
        && distance <= currentAttackRange + 1;
      const selected = isSameTile(state.selectedTile, x, y)
        || (occupant && occupant.id === state.selectedTargetId);

      if (state.player) {
        cell.classList.add(inRange ? 'in-range' : 'out-of-range');
        if (occupant?.isNpc) cell.classList.add('npc');
        if (rangePreview) cell.classList.add('range-preview');
        if (moveTarget) cell.classList.add('move-target');
        if (attackTarget) cell.classList.add('attack-target');
        if (npcTarget) cell.classList.add('npc-target');
        if (npcMoveTarget) cell.classList.add('npc-target');
        if (selected) cell.classList.add('selected-target');
        const selectable = moveTarget || attackTarget || npcTarget || npcMoveTarget;
        const allowedWhilePaused = state.actionMode === 'npc-placement';
        cell.disabled = (!allowedWhilePaused && (!state.settings.started || state.settings.paused))
          || !state.actionMode
          || !selectable;
      }

      if (occupant) {
        cell.classList.add('occupied');
        const token = document.createElement('span');
        token.className = 'token';
        token.textContent = occupant.displayName.substring(0, 2).toUpperCase();
        cell.appendChild(token);

        if (state.player && occupant.id === state.player.id) {
          cell.classList.add('me');
        }
      }

      cell.addEventListener('click', () => {
        if (!state.player) {
          showToast('Please log in first.', true);
          return;
        }
        if (state.actionMode === 'move' && moveTarget) {
          state.selectedTile = { x, y };
          renderAll();
          return;
        }
        if (state.actionMode === 'attack' && attackTarget) {
          state.selectedTargetId = occupant.id;
          renderAll();
          return;
        }
        if (state.actionMode === 'npc-placement' && npcTarget) {
          state.selectedTile = { x, y };
          renderAll();
          return;
        }
        if (state.actionMode === 'npc-move' && npcMoveTarget) {
          state.selectedTile = { x, y };
          renderAll();
          return;
        }
      });

      boardEl.appendChild(cell);
    }
  }
}

function populateAdminForm() {
  if (adminFormDirty) return;
  const nextTurnAt = state.settings.nextTurnAt ? new Date(state.settings.nextTurnAt).toISOString().slice(0, 16) : '';
  document.getElementById('adminNextTurnAt').value = nextTurnAt;
  document.getElementById('adminTurnInterval').value = state.settings.turnIntervalMs || 30000;
  document.getElementById('adminActionWindow').value = state.settings.actionWindowMs || 15000;
  document.getElementById('adminApPerTurn').value = state.settings.apPerTurn || 1;
  document.getElementById('adminReveal').checked = Boolean(state.settings.revealAttackerToVictim);
}

function updateActionControls() {
  const loggedIn = Boolean(state.player && !state.player.isNpc);
  playerActions.classList.toggle('hidden', !loggedIn);
  moveControls.classList.toggle('hidden', state.actionMode !== 'move');
  attackControls.classList.toggle('hidden', state.actionMode !== 'attack');
  rangeControls.classList.toggle('hidden', state.actionMode !== 'range');
  giveApControls.classList.toggle('hidden', state.actionMode !== 'give-ap');
  npcPlacementControls.classList.toggle('hidden', state.actionMode !== 'npc-placement');
  npcMoveControls.classList.toggle('hidden', state.actionMode !== 'npc-move');

  const isPaused = Boolean(state.settings.paused);
  const isStarted = Boolean(state.settings.started);
  const isAlive = Boolean(state.player?.alive);
  const playerAp = Number(state.player?.ap || 0);
  document.getElementById('moveModeBtn').disabled = !isStarted || isPaused || !isAlive || playerAp < 1;
  document.getElementById('attackModeBtn').disabled = !isStarted || isPaused || !isAlive || playerAp < 2;
  document.getElementById('rangeModeBtn').disabled = !isStarted || isPaused || !isAlive;
  document.getElementById('giveApModeBtn').disabled = !isStarted || isPaused || !isAlive || playerAp < 1;
  document.getElementById('confirmMoveBtn').disabled = !isStarted || isPaused || !isAlive || playerAp < 1 || !state.selectedTile;
  const attackTarget = state.players.find((player) => player.id === state.selectedTargetId && player.alive);
  const targetInRange = attackTarget
    && state.player
    && Math.abs(state.player.x - attackTarget.x) + Math.abs(state.player.y - attackTarget.y)
      <= 1 + Number(state.player.rangeLevel || 0);
  document.getElementById('confirmAttackBtn').disabled = !isStarted || isPaused || !isAlive || playerAp < 2 || !targetInRange;
  document.getElementById('attackSelectionLabel').textContent = attackTarget && targetInRange
    ? `Target: ${attackTarget.displayName}${attackTarget.isNpc ? ' (NPC)' : ''}`
    : 'Choose a highlighted player or NPC within your attack range.';
  document.getElementById('confirmRangeBtn').disabled = !isStarted || isPaused || !isAlive
    || Number(state.player?.rangeLevel || 0) >= 2
    || playerAp < (Number(state.player?.rangeLevel || 0) === 0 ? 2 : 4);
  document.getElementById('confirmGiveApBtn').disabled = !isStarted || isPaused || !isAlive
    || playerAp < 1
    || !document.getElementById('apRecipient').value;
  document.getElementById('moveSelectionLabel').textContent = state.selectedTile
    ? `Destination: ${state.selectedTile.x}, ${state.selectedTile.y}`
    : 'Choose one of the highlighted adjacent tiles.';
  const nextLevel = Number(state.player?.rangeLevel || 0) + 1;
  const rangeCost = nextLevel === 1 ? 2 : 4;
  document.getElementById('rangePreviewLabel').textContent = nextLevel > 2
    ? 'Attack range is already at its maximum.'
    : `Previewing +1 attack range. Permanent upgrade ${nextLevel}/2 costs ${rangeCost} AP.`;

  const confirmNpc = document.getElementById('confirmNpcBtn');
  confirmNpc.disabled = !state.selectedTile || !document.getElementById('npcName').value.trim();
  document.getElementById('npcLocationLabel').textContent = state.selectedTile
    ? `NPC location: ${state.selectedTile.x}, ${state.selectedTile.y}`
    : 'Click an empty tile to choose a location.';
  const selectedNpc = state.players.find((player) => player.id === state.selectedNpcId);
  const npcChoice = state.players.find((player) => player.id === document.getElementById('npcSelector').value);
  document.getElementById('confirmNpcMoveBtn').disabled = !isStarted || isPaused
    || !state.selectedTile
    || Number(selectedNpc?.ap || 0) < 1;
  document.getElementById('npcMoveLocationLabel').textContent = state.selectedTile
    ? `NPC destination: ${state.selectedTile.x}, ${state.selectedTile.y}`
    : 'Click an adjacent empty tile.';
  document.getElementById('startGameBtn').disabled = isStarted;
  document.getElementById('startGameBtn').textContent = isStarted ? 'Game started' : 'Start Game';
  document.getElementById('pauseGameBtn').textContent = isPaused ? 'Resume game' : 'Pause game';
  document.getElementById('pauseGameBtn').disabled = !isStarted;
  document.getElementById('moveNpcBtn').disabled = !isStarted || isPaused
    || !npcChoice
    || Number(npcChoice.ap || 0) < 1;
  const restartServerBtn = document.getElementById('restartServerBtn');
  restartServerBtn.disabled = state.serverRestartManaged;
  restartServerBtn.textContent = state.serverRestartManaged ? 'Restart via Render Dashboard' : 'Restart server';
  restartServerBtn.title = state.serverRestartManaged
    ? 'Restart hosted services from the Render Dashboard.'
    : '';
}

function updatePlayerActionSelectors() {
  const apRecipient = document.getElementById('apRecipient');
  const previousRecipient = apRecipient.value;
  const attackRange = 1 + Number(state.player?.rangeLevel || 0);
  const recipients = state.player ? state.players.filter((player) => (
    player.alive
    && !player.isNpc
    && player.id !== state.player?.id
    && Math.abs(player.x - state.player.x) + Math.abs(player.y - state.player.y) <= attackRange
  )) : [];
  apRecipient.innerHTML = '<option value="">Choose a player</option>';
  recipients.forEach((player) => {
    const option = document.createElement('option');
    option.value = player.id;
    option.textContent = player.displayName;
    apRecipient.appendChild(option);
  });
  if (recipients.some((player) => player.id === previousRecipient)) {
    apRecipient.value = previousRecipient;
  }
}

function updateNpcSelector() {
  const selector = document.getElementById('npcSelector');
  const previousId = selector.value;
  const npcs = state.players.filter((player) => player.isNpc && player.alive);
  selector.innerHTML = '<option value="">Choose an NPC</option>';
  npcs.forEach((npc) => {
    const option = document.createElement('option');
    option.value = npc.id;
    option.textContent = `${npc.displayName} (${npc.x}, ${npc.y}) — ${Number(npc.ap || 0)} AP`;
    selector.appendChild(option);
  });
  if (npcs.some((npc) => npc.id === previousId)) selector.value = previousId;
}

function showHowToPlay() {
  const info = document.createElement('div');
  info.className = 'panel';
  info.innerHTML = `
    <h3>How to play</h3>
    <div>1. Move to one of the 8 adjacent tiles, then confirm.</div>
    <div>2. The highlighted diamond shows 3-block range; dotted white tiles preview a range upgrade.</div>
    <div>3. Increase attack range permanently (max 2 upgrades), then confirm.</div>
    <div>4. Give another player 1 AP at a cost of 1 AP, or click an enemy in attack range.</div>
  `;
  const existing = document.querySelector('.how-to-play');
  if (existing) existing.remove();
  info.classList.add('how-to-play');
  document.querySelector('.board-panel').appendChild(info);
}

function renderAll() {
  modeLabel.textContent = state.mode.toUpperCase();
  renderStatus();
  renderPlayerList();
  renderPrivateState();
  renderBoard();
  updatePlayerActionSelectors();
  updateNpcSelector();
  updateActionControls();
  populateAdminForm();
  updateAuthVisibility();
  showHowToPlay();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('auth:login', {
    username: document.getElementById('loginUsername').value,
    password: document.getElementById('loginPassword').value
  });
});

profileForm.addEventListener('input', () => {
  profileFormDirty = true;
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('auth:register', {
    username: document.getElementById('registerUsername').value,
    displayName: document.getElementById('registerDisplayName').value,
    country: document.getElementById('registerCountry').value,
    password: document.getElementById('registerPassword').value
  });
});

profileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('player:updateProfile', {
    displayName: document.getElementById('profileDisplayName').value,
    country: document.getElementById('profileCountry').value
  });
});

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('player:changePassword', {
    currentPassword: document.getElementById('currentPassword').value,
    newPassword: document.getElementById('newPassword').value,
    confirmPassword: document.getElementById('confirmPassword').value
  });
});

adminForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nextTurnAtRaw = document.getElementById('adminNextTurnAt').value;
  const nextTurnAt = new Date(nextTurnAtRaw).getTime();
  socket.emit('admin:updateSettings', {
    nextTurnAt,
    turnIntervalMs: Number(document.getElementById('adminTurnInterval').value),
    actionWindowMs: Number(document.getElementById('adminActionWindow').value),
    apPerTurn: Number(document.getElementById('adminApPerTurn').value),
    revealAttackerToVictim: document.getElementById('adminReveal').checked
  });
});

adminForm.addEventListener('input', () => {
  adminFormDirty = true;
});

document.getElementById('moveModeBtn').addEventListener('click', () => setActionMode('move'));
document.getElementById('attackModeBtn').addEventListener('click', () => setActionMode('attack'));
document.getElementById('rangeModeBtn').addEventListener('click', () => setActionMode('range'));
document.getElementById('giveApModeBtn').addEventListener('click', () => setActionMode('give-ap'));
document.getElementById('confirmMoveBtn').addEventListener('click', () => {
  if (state.selectedTile) socket.emit('game:move', state.selectedTile);
});
document.getElementById('cancelMoveBtn').addEventListener('click', cancelAction);
document.getElementById('confirmAttackBtn').addEventListener('click', () => {
  if (state.selectedTargetId) socket.emit('game:attack', { targetId: state.selectedTargetId });
});
document.getElementById('cancelAttackBtn').addEventListener('click', cancelAction);
document.getElementById('confirmRangeBtn').addEventListener('click', () => socket.emit('game:upgradeRange'));
document.getElementById('cancelRangeBtn').addEventListener('click', cancelAction);
document.getElementById('confirmGiveApBtn').addEventListener('click', () => {
  const targetId = document.getElementById('apRecipient').value;
  if (targetId) socket.emit('game:giveAp', { targetId });
});
document.getElementById('cancelGiveApBtn').addEventListener('click', cancelAction);
document.getElementById('apRecipient').addEventListener('change', updateActionControls);

document.getElementById('pauseGameBtn').addEventListener('click', () => {
  socket.emit('admin:setPaused', { paused: !state.settings.paused });
});
document.getElementById('startGameBtn').addEventListener('click', () => {
  socket.emit('admin:startGame');
});
document.getElementById('resetGameBtn').addEventListener('click', () => {
  if (window.confirm('Reset game stats and positions, keep accounts, and remove all NPCs?')) {
    socket.emit('admin:resetGame');
  }
});
document.getElementById('restartServerBtn').addEventListener('click', () => {
  if (window.confirm('Restart the server? Saved game data will be preserved.')) {
    socket.emit('admin:restartServer');
  }
});

document.getElementById('placeNpcBtn').addEventListener('click', () => {
  setActionMode('npc-placement');
});
document.getElementById('npcName').addEventListener('input', updateActionControls);
document.getElementById('npcSelector').addEventListener('change', updateActionControls);
document.getElementById('confirmNpcBtn').addEventListener('click', () => {
  if (!state.selectedTile) return;
  socket.emit('admin:createNpc', {
    displayName: document.getElementById('npcName').value.trim(),
    ...state.selectedTile
  });
});
document.getElementById('cancelNpcBtn').addEventListener('click', cancelAction);
document.getElementById('moveNpcBtn').addEventListener('click', () => {
  const npcId = document.getElementById('npcSelector').value;
  if (!npcId) {
    showToast('Choose an NPC first.', true);
    return;
  }
  state.selectedNpcId = npcId;
  setActionMode('npc-move');
});
document.getElementById('confirmNpcMoveBtn').addEventListener('click', () => {
  if (!state.selectedTile || !state.selectedNpcId) return;
  socket.emit('admin:moveNpc', { npcId: state.selectedNpcId, ...state.selectedTile });
});
document.getElementById('cancelNpcMoveBtn').addEventListener('click', cancelAction);

document.getElementById('logoutBtn').addEventListener('click', () => {
  state.player = null;
  profileFormDirty = false;
  state.actionMode = null;
  state.selectedTile = null;
  socket.disconnect();
  socket.connect();
  renderAll();
});

socket.on('connect', () => {
  statusBox.textContent = 'Connected';
  fetch('/api/config')
    .then((response) => response.json())
    .then((config) => {
      state.mode = config.mode;
      state.settings = config.settings;
      state.boardSize = config.boardSize;
      state.serverRestartManaged = Boolean(config.serverRestartManaged);
      renderAll();
    })
    .catch(() => {
      state.mode = 'test';
      renderAll();
    });
});

socket.on('disconnect', () => {
  statusBox.textContent = 'Disconnected';
  state.player = null;
  state.actionMode = null;
  state.selectedTile = null;
  renderAll();
});

socket.on('auth:success', (payload) => {
  state.player = {
    id: payload.id,
    username: payload.username,
    displayName: payload.displayName,
    role: payload.role,
    country: payload.country || 'US',
    rangeLevel: payload.rangeLevel || 0
  };
  renderAll();
  showToast(`Logged in as ${payload.displayName}`);
});

socket.on('public:gameState', (payload) => {
  state.players = payload.players || [];
  state.settings = payload.settings || {};
  state.boardSize = payload.boardSize || 15;
  state.mode = payload.mode || state.mode;
  renderAll();
});

socket.on('private:playerState', (payload) => {
  state.player = {
    ...state.player,
    ...payload,
    id: payload.id,
    displayName: payload.displayName,
    username: payload.username,
    role: payload.role,
    country: payload.country
  };
  if (payload.settings) state.settings = payload.settings;
  renderAll();
});

socket.on('server:error', (payload) => {
  showToast(payload.message || 'An error occurred.', true);
});

socket.on('server:success', (payload) => {
  const message = payload.message || 'Success.';
  showToast(message);
  if (/^(Movement successful|Attack launched against |Attack range increased|.+ created at |.+ moved to |Game reset\.|Game started\.)/.test(message)) {
    cancelAction();
  }
  if (message === 'Game settings updated.') {
    adminFormDirty = false;
    populateAdminForm();
  }
  if (message === 'Profile updated.') {
    profileFormDirty = false;
    updateAuthVisibility();
  }
});

socket.on('admin:settings', (payload) => {
  state.settings = payload.settings || state.settings;
  renderAll();
});

socket.on('game:activity', (payload) => {
  showToast(payload.message || 'Game action completed.');
  if (payload.actorId === state.player?.id) cancelAction();
});

socket.on('auth:error', (payload) => {
  showToast(payload.message || 'Login failed.', true);
});

renderAll();
