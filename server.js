const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const MODE = (() => {
  const arg = process.argv.find((item) => item.startsWith('--mode='));
  const raw = arg ? arg.split('=')[1] : 'test';
  return raw === 'live' ? 'live' : 'test';
})();

const PORT = Number(process.env.PORT) || (MODE === 'live' ? 3000 : 3001);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SERVER_RESTART_MANAGED = process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
const DB_PATH = path.join(DATA_DIR, `${MODE}.db.json`);
const ADMIN_USERNAME = 'zrui.zr';
const BOARD_SIZE = 15;

const DEFAULT_SETTINGS = {
  nextTurnAt: Date.now() + 30000,
  turnIntervalMs: 30000,
  actionWindowMs: 15000,
  apPerTurn: 1,
  revealAttackerToVictim: false,
  paused: false,
  pausedAt: null,
  started: false,
  lastUpdatedBy: 'system'
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      players: [],
      settings: { ...DEFAULT_SETTINGS }
    };
    saveDb(initial);
    return initial;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read game data from ${DB_PATH}; the file was left unchanged.`, { cause: error });
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.players)) {
    throw new Error(`Invalid game data in ${DB_PATH}: expected a players array; the file was left unchanged.`);
  }
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    throw new Error(`Invalid game settings in ${DB_PATH}; the file was left unchanged.`);
  }
  return data;
}

function saveDb(data) {
  ensureDataDir();
  const temporaryPath = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryPath, DB_PATH);
}

function isActionWindowOpen(settings) {
  return Date.now() <= Number(settings.nextTurnAt || Date.now() + settings.turnIntervalMs) + Number(settings.actionWindowMs || 0);
}

function getDb() {
  const data = loadDb();
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data.players.forEach((player) => {
    if (player.rangeLevel === undefined) player.rangeLevel = 0;
  });
  return data;
}

function getPlayerByUsername(username) {
  const data = getDb();
  return data.players.find((player) => !player.isNpc && player.username.toLowerCase() === username.toLowerCase());
}

function getPublicPlayer(player) {
  return {
    id: player.id,
    username: player.username,
    displayName: player.displayName,
    country: player.country,
    x: player.x,
    y: player.y,
    alive: player.alive,
    hearts: player.hearts,
    role: player.role,
    isNpc: Boolean(player.isNpc),
    rangeLevel: Number(player.rangeLevel || 0),
    ...(player.isNpc ? { ap: Number(player.ap || 0) } : {})
  };
}

function findOpenTile(data) {
  const occupied = new Set(data.players.filter((player) => player.alive).map((player) => `${player.x},${player.y}`));
  const available = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (!occupied.has(`${x},${y}`)) {
        available.push({ x, y });
      }
    }
  }
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function createPlayer(username, displayName, country, passwordHash, role = 'player') {
  const data = getDb();
  const tile = findOpenTile(data);
  if (!tile) throw new Error('The board is full; no starting tile is available.');
  const player = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    username,
    displayName,
    country,
    passwordHash,
    role,
    x: tile.x,
    y: tile.y,
    alive: true,
    hearts: 5,
    ap: 3,
    rangeLevel: 0,
    createdAt: Date.now(),
    lastActionAt: Date.now()
  };
  data.players.push(player);
  saveDb(data);
  return player;
}

function ensureAdminAccount() {
  const data = getDb();
  const admin = data.players.find((player) => player.username.toLowerCase() === ADMIN_USERNAME);
  if (!admin) {
    const rawPassword = process.env.ADMIN_PASSWORD;
    if (!rawPassword) {
      throw new Error('ADMIN_PASSWORD must be set before the admin account can be created.');
    }
    const passwordHash = bcrypt.hashSync(rawPassword, 10);
    const adminPlayer = createPlayer(ADMIN_USERNAME, 'System Admin', 'US', passwordHash, 'admin');
    adminPlayer.displayName = 'Admin';
    saveDb(getDb());
    console.log(`Admin account created for ${ADMIN_USERNAME}.`);
  }
}

function sanitizePrivateState(player) {
  return {
    id: player.id,
    username: player.username,
    displayName: player.displayName,
    country: player.country,
    x: player.x,
    y: player.y,
    alive: player.alive,
    hearts: player.hearts,
    ap: player.ap,
    role: player.role,
    rangeLevel: Number(player.rangeLevel || 0),
    boardSize: BOARD_SIZE,
    settings: getDb().settings
  };
}

function isAdjacent(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;
}

function isWithinAttackRange(a, b, range) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= range;
}

function requireStartedGame(socket, data) {
  if (data.settings.started) return true;
  socket.emit('server:error', { message: 'The game has not started yet. Wait for the admin to start it.' });
  return false;
}

function emitAllState() {
  const data = getDb();
  const publicPlayers = data.players.map((player) => ({
    id: player.id,
    username: player.username,
    displayName: player.displayName,
    country: player.country,
    x: player.x,
    y: player.y,
    alive: player.alive,
    hearts: player.hearts,
    role: player.role,
    isNpc: Boolean(player.isNpc),
    rangeLevel: Number(player.rangeLevel || 0),
    ...(player.isNpc ? { ap: Number(player.ap || 0) } : {})
  }));
  io.emit('public:gameState', {
    mode: MODE,
    boardSize: BOARD_SIZE,
    settings: data.settings,
    players: publicPlayers,
    timestamp: Date.now()
  });
}

function sendPrivateState(socket, player) {
  socket.emit('private:playerState', sanitizePrivateState(player));
}

function updatePlayer(playerId, updater) {
  const data = getDb();
  const player = data.players.find((entry) => entry.id === playerId);
  if (!player) return null;
  const updated = updater(player, data);
  saveDb(data);
  return updated || player;
}

function advanceTurnIfNeeded() {
  const data = getDb();
  const settings = data.settings;
  if (!settings.started || settings.paused) return;
  const now = Date.now();
  if (now < Number(settings.nextTurnAt || Date.now() + settings.turnIntervalMs)) return;

  for (const player of data.players) {
    if (!player.alive) continue;
    player.ap = Number(settings.apPerTurn || 1);
    if (player.ap > 12) player.ap = 12;
  }

  settings.nextTurnAt = now + Number(settings.turnIntervalMs || 30000);
  settings.lastUpdatedBy = 'system';
  saveDb(data);
  emitAllState();
}

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/health', (req, res) => res.json({ ok: true, mode: MODE, port: PORT }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/config', (req, res) => {
  const data = getDb();
  res.json({
    mode: MODE,
    port: PORT,
    settings: data.settings,
    boardSize: BOARD_SIZE,
    serverRestartManaged: SERVER_RESTART_MANAGED
  });
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait a moment.' }
});

app.use('/api/auth', authLimiter);

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');
  const country = String(req.body.country || 'US').toUpperCase();

  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'Username, display name, and password are required.' });
  }

  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be at least 3 characters and password at least 6.' });
  }

  const data = getDb();
  if (data.players.some((player) => player.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'That username is already in use.' });
  }
  if (!findOpenTile(data)) {
    return res.status(409).json({ error: 'The board is full; no starting tile is available.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const created = createPlayer(username, displayName, country, passwordHash, 'player');
  return res.status(201).json({ ok: true, message: 'Account created successfully.', user: { username: created.username, displayName: created.displayName } });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const player = getPlayerByUsername(username);
  if (!player) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const valid = await bcrypt.compare(password, player.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  return res.json({ ok: true, user: { id: player.id, username: player.username, displayName: player.displayName, role: player.role } });
});

io.on('connection', (socket) => {
  socket.on('auth:login', async (payload = {}) => {
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const player = getPlayerByUsername(username);

    if (!player) {
      socket.emit('auth:error', { message: 'Invalid username or password.' });
      return;
    }

    const valid = await bcrypt.compare(password, player.passwordHash);
    if (!valid) {
      socket.emit('auth:error', { message: 'Invalid username or password.' });
      return;
    }

    socket.data.playerId = player.id;
    socket.emit('auth:success', { id: player.id, username: player.username, displayName: player.displayName, role: player.role });
    sendPrivateState(socket, player);
    emitAllState();
  });

  socket.on('auth:register', async (payload = {}) => {
    const username = String(payload.username || '').trim();
    const displayName = String(payload.displayName || '').trim();
    const password = String(payload.password || '');
    const country = String(payload.country || 'US').toUpperCase();

    if (!username || !displayName || !password) {
      socket.emit('server:error', { message: 'Please fill in all fields.' });
      return;
    }

    if (username.length < 3 || password.length < 6) {
      socket.emit('server:error', { message: 'Username must be at least 3 characters, password at least 6.' });
      return;
    }

    const data = getDb();
    if (data.players.some((player) => player.username.toLowerCase() === username.toLowerCase())) {
      socket.emit('server:error', { message: 'That username already exists.' });
      return;
    }
    if (!findOpenTile(data)) {
      socket.emit('server:error', { message: 'The board is full; no starting tile is available.' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const player = createPlayer(username, displayName, country, hash, 'player');
    socket.data.playerId = player.id;
    socket.emit('auth:success', { id: player.id, username: player.username, displayName: player.displayName, role: player.role });
    sendPrivateState(socket, player);
    emitAllState();
  });

  socket.on('player:updateProfile', async (payload = {}) => {
    const playerId = socket.data.playerId;
    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }

    const displayName = String(payload.displayName || '').trim();
    const country = String(payload.country || '').toUpperCase();

    if (displayName) player.displayName = displayName;
    if (country) player.country = country;

    saveDb(data);
    sendPrivateState(socket, player);
    emitAllState();
    socket.emit('server:success', { message: 'Profile updated.' });
  });

  socket.on('player:changePassword', async (payload = {}) => {
    const playerId = socket.data.playerId;
    const currentPassword = String(payload.currentPassword || '');
    const newPassword = String(payload.newPassword || '');
    const confirmPassword = String(payload.confirmPassword || '');

    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      socket.emit('server:error', { message: 'Current password, new password and confirmation are required.' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, player.passwordHash);
    if (!valid) {
      socket.emit('server:error', { message: 'Current password is incorrect.' });
      return;
    }

    if (newPassword.length < 6) {
      socket.emit('server:error', { message: 'New password must be at least 6 characters.' });
      return;
    }

    if (newPassword !== confirmPassword) {
      socket.emit('server:error', { message: 'New password and confirmation do not match.' });
      return;
    }

    player.passwordHash = await bcrypt.hash(newPassword, 10);
    saveDb(data);
    socket.emit('server:success', { message: 'Password updated securely.' });
  });

  socket.on('game:move', (payload = {}) => {
    const playerId = socket.data.playerId;
    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }
    if (!player.alive) {
      socket.emit('server:error', { message: 'Your character is eliminated.' });
      return;
    }

    const settings = data.settings;
    if (!requireStartedGame(socket, data)) return;
    if (settings.paused) {
      socket.emit('server:error', { message: 'The game is paused.' });
      return;
    }
    const now = Date.now();
    const windowDeadline = Number(settings.nextTurnAt || now + Number(settings.turnIntervalMs || 30000));
    const actionWindowOpen = now <= windowDeadline;
    if (!actionWindowOpen) {
      socket.emit('server:error', { message: 'The action window is closed.' });
      return;
    }

    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      socket.emit('server:error', { message: 'Invalid target tile.' });
      return;
    }

    if (player.ap < 1) {
      socket.emit('server:error', { message: 'Not enough AP to move.' });
      return;
    }

    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      socket.emit('server:error', { message: 'Target tile is outside the board.' });
      return;
    }

    if (player.x === x && player.y === y) {
      socket.emit('server:error', { message: 'Choose a different tile.' });
      return;
    }

    if (!isAdjacent(player, { x, y })) {
      socket.emit('server:error', { message: 'You can only move to an adjacent square.' });
      return;
    }

    const occupant = data.players.find((entry) => entry.id !== player.id && entry.alive && entry.x === x && entry.y === y);
    if (occupant) {
      socket.emit('server:error', { message: 'You cannot move onto an occupied square.' });
      return;
    }

    player.x = x;
    player.y = y;
    player.ap -= 1;
    player.lastActionAt = Date.now();
    saveDb(data);
    sendPrivateState(socket, player);
    emitAllState();
    socket.emit('server:success', { message: 'Movement successful.' });
  });

  socket.on('game:attack', (payload = {}) => {
    const playerId = socket.data.playerId;
    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }

    if (!player.alive) {
      socket.emit('server:error', { message: 'Your character is eliminated.' });
      return;
    }

    const settings = data.settings;
    if (!requireStartedGame(socket, data)) return;
    if (settings.paused) {
      socket.emit('server:error', { message: 'The game is paused.' });
      return;
    }
    const now = Date.now();
    const actionWindowOpen = now <= Number(settings.nextTurnAt || now + Number(settings.turnIntervalMs || 30000));
    if (!actionWindowOpen) {
      socket.emit('server:error', { message: 'The action window is closed.' });
      return;
    }

    if (player.ap < 2) {
      socket.emit('server:error', { message: 'Not enough AP to attack.' });
      return;
    }

    const targetId = String(payload.targetId || '');
    const target = data.players.find((entry) => entry.id === targetId && entry.alive && entry.id !== player.id);
    if (!target) {
      socket.emit('server:error', { message: 'Target not found.' });
      return;
    }

    const attackRange = 1 + Number(player.rangeLevel || 0);
    if (!isWithinAttackRange(player, target, attackRange)) {
      socket.emit('server:error', { message: `Target is outside your attack range of ${attackRange}.` });
      return;
    }

    target.hearts -= 1;
    player.ap -= 2;
    player.lastActionAt = Date.now();

    if (target.hearts <= 0) {
      target.alive = false;
      target.hearts = 0;
      target.x = 0;
      target.y = 0;
      if (settings.revealAttackerToVictim) {
        io.to(Array.from(io.sockets.sockets.keys()).find((id) => {
          const socketInstance = io.sockets.sockets.get(id);
          return socketInstance && socketInstance.data.playerId === target.id;
        }) || '').emit('server:alert', { message: `You were eliminated by ${player.displayName}.` });
      }
    }

    if (target.alive && settings.revealAttackerToVictim) {
      const targetSocket = Array.from(io.sockets.sockets.values()).find((instance) => instance.data.playerId === target.id);
      if (targetSocket) {
        targetSocket.emit('server:alert', { message: `${player.displayName} attacked you.` });
      }
    }

    saveDb(data);
    emitAllState();
    sendPrivateState(socket, player);
    socket.emit('server:success', { message: `Attack launched against ${target.displayName}.` });
  });

  socket.on('game:upgradeRange', () => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.isNpc) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }
    if (!player.alive) {
      socket.emit('server:error', { message: 'Your character is eliminated.' });
      return;
    }
    if (!requireStartedGame(socket, data)) return;
    if (data.settings.paused) {
      socket.emit('server:error', { message: 'The game is paused.' });
      return;
    }

    const rangeLevel = Number(player.rangeLevel || 0);
    if (rangeLevel >= 2) {
      socket.emit('server:error', { message: 'Attack range is already at its maximum.' });
      return;
    }

    const cost = rangeLevel === 0 ? 2 : 4;
    if (player.ap < cost) {
      socket.emit('server:error', { message: `Not enough AP to increase range (cost: ${cost} AP).` });
      return;
    }

    player.ap -= cost;
    player.rangeLevel = rangeLevel + 1;
    player.lastActionAt = Date.now();
    saveDb(data);
    sendPrivateState(socket, player);
    emitAllState();
    socket.emit('server:success', {
      message: `Attack range increased to ${1 + player.rangeLevel} (cost: ${cost} AP).`
    });
  });

  socket.on('game:giveAp', (payload = {}) => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.isNpc) {
      socket.emit('server:error', { message: 'Please log in first.' });
      return;
    }
    if (!player.alive) {
      socket.emit('server:error', { message: 'Your character is eliminated.' });
      return;
    }
    if (!requireStartedGame(socket, data)) return;
    if (data.settings.paused) {
      socket.emit('server:error', { message: 'The game is paused.' });
      return;
    }
    if (Number(player.ap) < 1) {
      socket.emit('server:error', { message: 'Not enough AP to give 1 AP.' });
      return;
    }

    const target = data.players.find((entry) => (
      entry.id === String(payload.targetId || '')
      && entry.alive
      && entry.id !== player.id
      && !entry.isNpc
    ));
    if (!target || !isWithinAttackRange(player, target, 1 + Number(player.rangeLevel || 0))) {
      socket.emit('server:error', { message: 'Choose a living player within your attack range to receive AP.' });
      return;
    }

    player.ap -= 1;
    target.ap = Number(target.ap || 0) + 1;
    player.lastActionAt = Date.now();
    saveDb(data);
    emitAllState();
    sendPrivateState(socket, player);
    for (const client of io.sockets.sockets.values()) {
      if (client.data.playerId === target.id) sendPrivateState(client, target);
    }
    const message = `${player.displayName} gave 1 AP to ${target.displayName} (cost: 1 AP).`;
    io.emit('game:activity', { message, actorId: player.id });
  });

  socket.on('admin:updateSettings', (payload = {}) => {
    const playerId = socket.data.playerId;
    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }

    const nextTurnAt = Number(payload.nextTurnAt || data.settings.nextTurnAt || Date.now() + data.settings.turnIntervalMs);
    const turnIntervalMs = Number(payload.turnIntervalMs || data.settings.turnIntervalMs || 30000);
    const actionWindowMs = Number(payload.actionWindowMs || data.settings.actionWindowMs || 15000);
    const apPerTurn = Number(payload.apPerTurn || data.settings.apPerTurn || 1);
    const revealAttackerToVictim = Boolean(payload.revealAttackerToVictim ?? data.settings.revealAttackerToVictim);

    data.settings = {
      ...data.settings,
      nextTurnAt,
      turnIntervalMs,
      actionWindowMs,
      apPerTurn,
      revealAttackerToVictim,
      lastUpdatedBy: player.username
    };
    saveDb(data);
    emitAllState();
    socket.emit('admin:settings', { settings: data.settings });
    socket.emit('server:success', { message: 'Game settings updated.' });
  });

  socket.on('admin:startGame', () => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }
    if (data.settings.started) {
      socket.emit('server:error', { message: 'The game has already started. Reset the game to start a new one.' });
      return;
    }

    data.settings.started = true;
    data.settings.paused = false;
    delete data.settings.pausedAt;
    data.settings.nextTurnAt = Date.now() + Number(data.settings.turnIntervalMs || 30000);
    data.settings.lastUpdatedBy = player.username;
    saveDb(data);
    emitAllState();
    socket.emit('server:success', { message: 'Game started. Good luck!' });
  });

  socket.on('admin:setPaused', (payload = {}) => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }

    if (!data.settings.started) {
      socket.emit('server:error', { message: 'Start the game before pausing it.' });
      return;
    }

    const paused = Boolean(payload.paused);
    if (paused !== Boolean(data.settings.paused)) {
      if (paused) {
        data.settings.pausedAt = Date.now();
      } else {
        const pausedDuration = Math.max(0, Date.now() - Number(data.settings.pausedAt || Date.now()));
        data.settings.nextTurnAt = Number(data.settings.nextTurnAt || Date.now()) + pausedDuration;
        delete data.settings.pausedAt;
      }
      data.settings.paused = paused;
      data.settings.lastUpdatedBy = player.username;
      saveDb(data);
    }

    emitAllState();
    socket.emit('server:success', { message: paused ? 'Game paused.' : 'Game resumed.' });
  });

  socket.on('admin:resetGame', () => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }

    data.players = data.players.filter((entry) => !entry.isNpc);
    for (const entry of data.players) {
      entry.x = -1;
      entry.y = -1;
      entry.alive = true;
      entry.hearts = 5;
      entry.ap = 3;
      entry.rangeLevel = 0;
      entry.lastActionAt = Date.now();
    }
    for (const entry of data.players) {
      const tile = findOpenTile(data);
      entry.x = tile.x;
      entry.y = tile.y;
    }

    data.settings.paused = false;
    data.settings.started = false;
    delete data.settings.pausedAt;
    data.settings.nextTurnAt = Date.now() + Number(data.settings.turnIntervalMs || 30000);
    data.settings.lastUpdatedBy = player.username;
    saveDb(data);
    emitAllState();
    for (const client of io.sockets.sockets.values()) {
      const currentPlayer = data.players.find((entry) => entry.id === client.data.playerId);
      if (currentPlayer) sendPrivateState(client, currentPlayer);
    }
    socket.emit('server:success', { message: 'Game reset. Accounts were kept and NPCs were removed.' });
  });

  socket.on('admin:createNpc', (payload = {}) => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }

    const x = Number(payload.x);
    const y = Number(payload.y);
    const displayName = String(payload.displayName || '').trim().slice(0, 40);
    if (!displayName || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      socket.emit('server:error', { message: 'Choose a name and a valid board tile for the NPC.' });
      return;
    }
    if (data.players.some((entry) => entry.alive && entry.x === x && entry.y === y)) {
      socket.emit('server:error', { message: 'Choose an empty tile for the NPC.' });
      return;
    }

    const now = Date.now();
    const id = `npc-${now}-${Math.random().toString(16).slice(2, 8)}`;
    data.players.push({
      id,
      username: id,
      displayName,
      country: '',
      passwordHash: '',
      role: 'npc',
      isNpc: true,
      x,
      y,
      alive: true,
      hearts: 5,
      ap: 3,
      rangeLevel: 0,
      createdAt: now,
      lastActionAt: now
    });
    saveDb(data);
    emitAllState();
    socket.emit('server:success', { message: `${displayName} created at ${x}, ${y}.` });
  });

  socket.on('admin:moveNpc', (payload = {}) => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }
    if (!requireStartedGame(socket, data)) return;
    if (data.settings.paused) {
      socket.emit('server:error', { message: 'The game is paused.' });
      return;
    }

    const npc = data.players.find((entry) => entry.id === String(payload.npcId || '') && entry.isNpc && entry.alive);
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!npc || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      socket.emit('server:error', { message: 'Choose a valid NPC and destination.' });
      return;
    }
    if (!isAdjacent(npc, { x, y })) {
      socket.emit('server:error', { message: 'NPCs can only move to an adjacent tile.' });
      return;
    }
    if (npc.ap < 1) {
      socket.emit('server:error', { message: 'The NPC does not have enough AP to move.' });
      return;
    }
    if (data.players.some((entry) => entry.id !== npc.id && entry.alive && entry.x === x && entry.y === y)) {
      socket.emit('server:error', { message: 'Choose an empty destination tile.' });
      return;
    }

    npc.x = x;
    npc.y = y;
    npc.ap -= 1;
    npc.lastActionAt = Date.now();
    saveDb(data);
    emitAllState();
    socket.emit('server:success', { message: `${npc.displayName} moved to ${x}, ${y}.` });
  });

  socket.on('admin:restartServer', () => {
    const data = getDb();
    const player = data.players.find((entry) => entry.id === socket.data.playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }
    if (SERVER_RESTART_MANAGED) {
      socket.emit('server:error', { message: 'Restart this hosted server from the Render Dashboard.' });
      return;
    }

    saveDb(data);
    socket.emit('server:success', { message: 'Server is restarting; saved game data will be preserved.' });
    setTimeout(() => {
      io.close(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: __dirname,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.once('error', (error) => {
          console.error('Could not restart the game server:', error);
          process.exit(1);
        });
        child.once('spawn', () => {
          child.unref();
          process.exit(0);
        });
      });
    }, 500);
  });

  socket.on('admin:getSettings', () => {
    const playerId = socket.data.playerId;
    const data = getDb();
    const player = data.players.find((entry) => entry.id === playerId);
    if (!player || player.role !== 'admin') {
      socket.emit('server:error', { message: 'Admin privileges required.' });
      return;
    }
    socket.emit('admin:settings', { settings: data.settings });
  });

  socket.on('disconnect', () => {
    // no-op
  });
});

ensureAdminAccount();
setInterval(() => {
  advanceTurnIfNeeded();
  emitAllState();
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ALLIANCES ${MODE} server is running on http://localhost:${PORT}`);
});
