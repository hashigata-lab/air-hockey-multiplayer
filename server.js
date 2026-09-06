const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const connectDB = require('./db');
const User = require('./models/User');

// Connect to MongoDB
connectDB();

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- API Endpoints ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: 'Username already taken' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashedPassword });
        await user.save();
        
        const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET || 'secret123');
        res.json({ token, username: user.username, rating: user.rating });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });
        
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET || 'secret123');
        res.json({ token, username: user.username, rating: user.rating });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/me', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(401).json({ error: 'No token' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ username: user.username, rating: user.rating });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const users = await User.find({}, 'username rating').sort({ rating: -1 }).limit(10);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ---------------------

app.use(express.static(path.join(__dirname, 'public')));

// ゲームの論理サイズと定数
const PUCK_RADIUS = 15;
const PADDLE_RADIUS = 35;
const ITEM_RADIUS = 20;
const ROLES = ['bottom', 'top', 'left', 'right'];
const INITIAL_LIVES = 5;
const MIN_PLAYERS_TO_START = 2;

const ITEM_TYPES = ['SIZE_UP', 'SIZE_DOWN', 'BARRIER', 'SPEED_UP', 'MULTI_PUCK'];
const EFFECT_DURATION = 10000; // 10秒

// ルーム管理
const rooms = {};
const connectedClients = {}; // socket.id -> { roomId, role, name }


async function handleGameOver(roomState, winnerRole) {
    roomState.status = 'GAMEOVER';
    roomState.events.push('gameover');
    const winnerName = winnerRole ? (roomState.players[winnerRole].name || winnerRole.toUpperCase()) : 'Draw';
    roomState.winner = winnerName;
    
    // Update Ratings in MongoDB
    const pointsChanges = {};
    for (let role of ROLES) {
        const player = roomState.players[role];
        if (player.active || player.eliminated) {
            if (player.name) {
                try {
                    const dbUser = await User.findOne({ username: player.name });
                    if (dbUser) {
                        const change = (role === winnerRole) ? 30 : -10;
                        dbUser.rating += change;
                        await dbUser.save();
                        pointsChanges[role] = change;
                    }
                } catch (e) {
                    console.error("DB Error updating rating:", e);
                }
            }
        }
    }
    roomState.pointsChanges = pointsChanges;
}

function createInitialGameState(boardSize = 800) {
    const BOARD_SIZE = boardSize;
    const GOAL_SIZE = Math.floor(BOARD_SIZE * 0.3);
    return {
        events: [],
        pucks: [{ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null, isHyper: false }],
        items: [],
        itemSpawnTimer: 0,
        players: {
            bottom: { x: BOARD_SIZE / 2, y: BOARD_SIZE - PADDLE_RADIUS - 20, active: false, id: null, name: '', color: '#ff4444', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null, sp: 0, lastX: 0, lastY: 0, lastSpeed: 0, skin: 'DEFAULT' },
            top:    { x: BOARD_SIZE / 2, y: PADDLE_RADIUS + 20, active: false, id: null, name: '', color: '#4444ff', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null, sp: 0, lastX: 0, lastY: 0, lastSpeed: 0, skin: 'DEFAULT' },
            left:   { x: PADDLE_RADIUS + 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#44ff44', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null, sp: 0, lastX: 0, lastY: 0, lastSpeed: 0, skin: 'DEFAULT' },
            right:  { x: BOARD_SIZE - PADDLE_RADIUS - 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#ffff44', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null, sp: 0, lastX: 0, lastY: 0, lastSpeed: 0, skin: 'DEFAULT' }
        },
        status: 'WAITING',
        stage: 'CYBERPUNK',
        boardSize: boardSize,
        winner: null
    };
}

function resetPucks(roomState) {
    const BOARD_SIZE = roomState.boardSize || 800;
    const GOAL_SIZE = Math.floor(BOARD_SIZE * 0.3);
    roomState.events = [];
    roomState.pucks = [{ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null, isHyper: false }];
    roomState.items = [];
    roomState.itemSpawnTimer = 0;
    
    // reset player statuses
    for (let role of ROLES) {
        roomState.players[role].paddleRadius = PADDLE_RADIUS;
        roomState.players[role].barrierActive = false;
        roomState.players[role].activeEffect = null;
        roomState.players[role].sp = 0;
    }
}

function getActivePlayersCount(roomState) {
    return ROLES.filter(r => roomState.players[r].active).length;
}

function startGame(roomId) {
    const roomState = rooms[roomId];
    if (!roomState) return;

    if (roomState.status === 'WAITING' && getActivePlayersCount(roomState) >= MIN_PLAYERS_TO_START) {
        roomState.status = 'PLAYING';
        roomState.winner = null;
        
        for (let role of ROLES) {
            if (roomState.players[role].active) {
                roomState.players[role].lives = INITIAL_LIVES;
                roomState.players[role].eliminated = false;
            } else {
                roomState.players[role].eliminated = true; 
            }
        }
        resetPucks(roomState);
        io.to(roomId).emit('system_message', 'Game Started!');
    }
}

async function handleGoal(roomId, role, puckIndex) {
    const BOARD_SIZE = rooms[roomId]?.boardSize || 800;
    const roomState = rooms[roomId];
    if (!roomState || roomState.status !== 'PLAYING') return;

    roomState.events.push('goal');

    let p = roomState.players[role];
    if (!p.eliminated) {
        p.lives--;
        p.sp = Math.min(100, p.sp + 30);
        io.to(roomId).emit('system_message', `${p.name || role.toUpperCase()} was scored on!`);

        if (p.lives <= 0) {
            p.eliminated = true;
            p.lives = 0;
            io.to(roomId).emit('system_message', `${p.name || role.toUpperCase()} is eliminated!`);
        }
    }

    // パックを削除
    roomState.pucks.splice(puckIndex, 1);

    let aliveRoles = ROLES.filter(r => roomState.players[r].active && !roomState.players[r].eliminated);
    
    if (aliveRoles.length <= 1) {
        const winnerRole = aliveRoles.length === 1 ? aliveRoles[0] : null;
        await handleGameOver(roomState, winnerRole);
        const winnerName = roomState.winner;
        
        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
        
        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
    } else {
        if (roomState.pucks.length === 0) {
            setTimeout(() => {
                if (rooms[roomId] && rooms[roomId].status === 'PLAYING') {
                    rooms[roomId].pucks.push({ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null, isHyper: false });
                }
            }, 1000);
        }
    }
}

function applyItemEffect(roomId, type, puck) {
    const BOARD_SIZE = rooms[roomId]?.boardSize || 800;
    const roomState = rooms[roomId];
    if (!roomState) return;

    const targetRole = puck.lastHitter;
    const targetPlayer = targetRole ? roomState.players[targetRole] : null;

    let msg = `Item Activated: ${type}!`;
    if (targetRole && type !== 'SPEED_UP' && type !== 'MULTI_PUCK') {
        msg = `${roomState.players[targetRole].name || targetRole} got ${type}!`;
    }
    io.to(roomId).emit('system_message', msg);

    switch (type) {
        case 'SIZE_UP':
            if (targetPlayer) {
                targetPlayer.paddleRadius = PADDLE_RADIUS * 1.5;
                targetPlayer.activeEffect = { type: 'SIZE_UP', endTime: Date.now() + EFFECT_DURATION, ratio: 1.0 };
                setTimeout(() => {
                    if (rooms[roomId] && rooms[roomId].players[targetRole]) {
                        rooms[roomId].players[targetRole].paddleRadius = PADDLE_RADIUS;
                        if (rooms[roomId].players[targetRole].activeEffect?.type === 'SIZE_UP') rooms[roomId].players[targetRole].activeEffect = null;
                    }
                }, EFFECT_DURATION);
            }
            break;
        case 'SIZE_DOWN':
            if (targetPlayer) {
                targetPlayer.paddleRadius = PADDLE_RADIUS * 0.5;
                targetPlayer.activeEffect = { type: 'SIZE_DOWN', endTime: Date.now() + EFFECT_DURATION, ratio: 1.0 };
                setTimeout(() => {
                    if (rooms[roomId] && rooms[roomId].players[targetRole]) {
                        rooms[roomId].players[targetRole].paddleRadius = PADDLE_RADIUS;
                        if (rooms[roomId].players[targetRole].activeEffect?.type === 'SIZE_DOWN') rooms[roomId].players[targetRole].activeEffect = null;
                    }
                }, EFFECT_DURATION);
            }
            break;
        case 'BARRIER':
            if (targetPlayer) {
                targetPlayer.barrierActive = true;
                targetPlayer.activeEffect = { type: 'BARRIER', endTime: Date.now() + EFFECT_DURATION, ratio: 1.0 };
                setTimeout(() => {
                    if (rooms[roomId] && rooms[roomId].players[targetRole]) {
                        rooms[roomId].players[targetRole].barrierActive = false;
                        if (rooms[roomId].players[targetRole].activeEffect?.type === 'BARRIER') rooms[roomId].players[targetRole].activeEffect = null;
                    }
                }, EFFECT_DURATION);
            }
            break;
        case 'SPEED_UP':
            roomState.pucks.forEach(p => {
                p.vx *= 1.5;
                p.vy *= 1.5;
                if(p.vx === 0 && p.vy === 0) {
                    p.vx = (Math.random() - 0.5) * 10;
                    p.vy = (Math.random() - 0.5) * 10;
                }
            });
            break;
        case 'MULTI_PUCK':
            roomState.pucks.push({
                x: BOARD_SIZE / 2,
                y: BOARD_SIZE / 2,
                vx: (Math.random() > 0.5 ? 1 : -1) * 8,
                vy: (Math.random() > 0.5 ? 1 : -1) * 8,
                lastHitter: null,
                isHyper: false
            });
            break;
    }
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, playerName }) => {
        if (connectedClients[socket.id]) return; 

        socket.join(roomId);
        socket.roomId = roomId;

        if (!rooms[roomId]) {
            rooms[roomId] = createInitialGameState();
        }
        
        const roomState = rooms[roomId];
        let assignedRole = null;
        
        for (let role of ROLES) {
            if (!roomState.players[role].active) {
                assignedRole = role;
                socket.role = role;
                roomState.players[role].active = true;
                roomState.players[role].id = socket.id;
                roomState.players[role].name = playerName || `Player ${Math.floor(Math.random() * 1000)}`;
                
                if (roomState.status === 'PLAYING') {
                    roomState.players[role].eliminated = true;
                    roomState.players[role].lives = 0;
                } else {
                    roomState.players[role].eliminated = false;
                    roomState.players[role].lives = INITIAL_LIVES;
                }
                break;
            }
        }

        connectedClients[socket.id] = { roomId, role: assignedRole, name: playerName };

        if (assignedRole) {
            socket.emit('assigned_role', assignedRole);
            io.to(roomId).emit('system_message', `${roomState.players[assignedRole].name} joined as ${assignedRole}`);
        } else {
            socket.emit('spectator');
            io.to(roomId).emit('system_message', `${playerName || 'Spectator'} joined as spectator`);
        }
    });

    socket.on('chat_message', (msg) => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo) {
            io.to(clientInfo.roomId).emit('chat_message', { name: clientInfo.name || 'Spectator', message: msg });
        }
    });

    socket.on('start_game', () => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo && clientInfo.roomId) {
            startGame(clientInfo.roomId);
        }
    });

    socket.on('restart_game', () => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo && clientInfo.roomId) {
            const roomState = rooms[clientInfo.roomId];
            if (roomState && roomState.status === 'GAMEOVER') {
                roomState.status = 'WAITING';
                roomState.winner = null;
                resetPucks(roomState);
                io.to(clientInfo.roomId).emit('game_state', roomState);
                io.to(clientInfo.roomId).emit('system_message', 'Game restarted. Waiting for players to be ready.');
            }
        }
    });

    socket.on('return_lobby', () => {
        socket.disconnect(); // Triggers the existing disconnect logic to leave room
    });

    
    socket.on('change_stage', (stage) => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo && clientInfo.roomId) {
            const roomState = rooms[clientInfo.roomId];
            if (roomState && roomState.status === 'WAITING') {
                roomState.stage = stage;
                io.to(clientInfo.roomId).emit('game_state', roomState);
            }
        }
    });

    socket.on('change_size', (size) => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo && clientInfo.roomId) {
            const roomState = rooms[clientInfo.roomId];
            if (roomState && roomState.status === 'WAITING') {
                roomState.boardSize = size;
                io.to(clientInfo.roomId).emit('game_state', roomState);
            }
        }
    });


    socket.on('change_skin', (skinId) => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo && clientInfo.roomId && socket.role) {
            const roomState = rooms[clientInfo.roomId];
            if (roomState && roomState.players[socket.role]) {
                roomState.players[socket.role].skin = skinId;
            }
        }
    });

    socket.on('player_input', (data) => {
        const roomState = rooms[socket.roomId];
        if (roomState && roomState.status === 'PLAYING' && socket.role) {
            const BOARD_SIZE = roomState.boardSize || 800;
            let p = roomState.players[socket.role];
            if (p && !p.eliminated) {
                let dx = data.x - p.lastX;
                let dy = data.y - p.lastY;
                p.lastSpeed = Math.sqrt(dx * dx + dy * dy);
                
                let x = data.x;
                let y = data.y;
                let pr = p.paddleRadius;
                
                if (socket.role === 'bottom') {
                    x = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
                    y = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, y));
                } else if (socket.role === 'top') {
                    x = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
                    y = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, y));
                } else if (socket.role === 'left') {
                    x = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, x));
                    y = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
                } else if (socket.role === 'right') {
                    x = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, x));
                    y = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
                }

                p.x = x;
                p.y = y;
                p.lastX = x;
                p.lastY = y;
            }
        }
    });

    socket.on('disconnect', async () => {
        const clientInfo = connectedClients[socket.id];
        if (clientInfo) {
            const { roomId, role } = clientInfo;
            const roomState = rooms[roomId];

            if (roomState && role) {
                roomState.players[role].active = false;
                roomState.players[role].eliminated = true;
                roomState.players[role].id = null;
                roomState.players[role].paddleRadius = PADDLE_RADIUS;
                roomState.players[role].barrierActive = false;
                
                const BOARD_SIZE = roomState.boardSize || 800;
                if (role === 'bottom') { roomState.players[role].x = BOARD_SIZE/2; roomState.players[role].y = BOARD_SIZE - PADDLE_RADIUS - 20; }
                if (role === 'top')    { roomState.players[role].x = BOARD_SIZE/2; roomState.players[role].y = PADDLE_RADIUS + 20; }
                if (role === 'left')   { roomState.players[role].x = PADDLE_RADIUS + 20; roomState.players[role].y = BOARD_SIZE/2; }
                if (role === 'right')  { roomState.players[role].x = BOARD_SIZE - PADDLE_RADIUS - 20; roomState.players[role].y = BOARD_SIZE/2; }
                
                io.to(roomId).emit('system_message', `${roomState.players[role].name} left the game.`);

                if (roomState.status === 'PLAYING') {
                    let aliveRoles = ROLES.filter(r => roomState.players[r].active && !roomState.players[r].eliminated);
                    if (aliveRoles.length <= 1) {
                        const winnerRole = aliveRoles.length === 1 ? aliveRoles[0] : null;
                        await handleGameOver(roomState, winnerRole);
                        const winnerName = roomState.winner;
                        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
                    }
                }

                if (getActivePlayersCount(roomState) === 0) {
                    let hasClients = false;
                    for (let sid in connectedClients) {
                        if (sid !== socket.id && connectedClients[sid].roomId === roomId) {
                            hasClients = true; break;
                        }
                    }
                    if (!hasClients) {
                        delete rooms[roomId];
                    }
                }
            } else if (roomState && !role) {
                io.to(roomId).emit('system_message', `${clientInfo.name || 'Spectator'} left the room.`);
                let hasClients = false;
                for (let sid in connectedClients) {
                    if (sid !== socket.id && connectedClients[sid].roomId === roomId) {
                        hasClients = true; break;
                    }
                }
                if (!hasClients) {
                    delete rooms[roomId];
                }
            }
        }
        delete connectedClients[socket.id];
    });
});

const FPS = 60;
const INTERVAL = 1000 / FPS;

setInterval(() => {
    for (const roomId in rooms) {
        const roomState = rooms[roomId];
        const BOARD_SIZE = roomState.boardSize || 800;
        const GOAL_SIZE = Math.floor(BOARD_SIZE * 0.3);
        
        if (roomState.status !== 'PLAYING') {
            io.to(roomId).emit('game_state', roomState);
            continue;
        }

        // Item Spawning
        roomState.itemSpawnTimer += INTERVAL;
        if (roomState.itemSpawnTimer >= 12000) { // Every 12 seconds
            roomState.itemSpawnTimer = 0;
            if (roomState.items.length < 3) {
                roomState.events.push('item_spawn');
                roomState.items.push({
                    x: 250 + Math.random() * 300,
                    y: 250 + Math.random() * 300,
                    type: ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)]
                });
            }
        }

        const goalStart = (BOARD_SIZE - GOAL_SIZE) / 2;
        const goalEnd = goalStart + GOAL_SIZE;

        // マレットの速度計算
        let mallet_v = {};
        for (let role of ROLES) {
            let p = roomState.players[role];
            if (p.active && !p.eliminated) {
                if (p.prevTickX === undefined) { p.prevTickX = p.x; p.prevTickY = p.y; }
                mallet_v[role] = { vx: p.x - p.prevTickX, vy: p.y - p.prevTickY };
                p.prevTickX = p.x;
                p.prevTickY = p.y;
            }
        }

        for (let i = roomState.pucks.length - 1; i >= 0; i--) {
            let puck = roomState.pucks[i];
            let scored = false;

            puck.x += puck.vx;
            puck.y += puck.vy;

            // Friction and Limit
            puck.vx *= 0.99;
            puck.vy *= 0.99;
            let currentSpeed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
            let limit = puck.isHyper ? 35 : 15;
            if (currentSpeed > limit) {
                puck.vx = (puck.vx / currentSpeed) * limit;
                puck.vy = (puck.vy / currentSpeed) * limit;
            }

            // ゴール判定 or 壁反射
            if (puck.x - PUCK_RADIUS < 0) {
                if (puck.y > goalStart && puck.y < goalEnd && !roomState.players['left'].eliminated) {
                    handleGoal(roomId, 'left', i);
                    scored = true;
                } else {
                    puck.x = PUCK_RADIUS;
                    puck.vx *= -1;
                    roomState.events.push('wall');
                }
            } else if (puck.x + PUCK_RADIUS > BOARD_SIZE) {
                if (puck.y > goalStart && puck.y < goalEnd && !roomState.players['right'].eliminated) {
                    handleGoal(roomId, 'right', i);
                    scored = true;
                } else {
                    puck.x = BOARD_SIZE - PUCK_RADIUS;
                    puck.vx *= -1;
                    roomState.events.push('wall');
                }
            }

            if (scored) continue;

            if (puck.y - PUCK_RADIUS < 0) {
                if (puck.x > goalStart && puck.x < goalEnd && !roomState.players['top'].eliminated) {
                    handleGoal(roomId, 'top', i);
                    scored = true;
                } else {
                    puck.y = PUCK_RADIUS;
                    puck.vy *= -1;
                    roomState.events.push('wall');
                }
            } else if (puck.y + PUCK_RADIUS > BOARD_SIZE) {
                if (puck.x > goalStart && puck.x < goalEnd && !roomState.players['bottom'].eliminated) {
                    handleGoal(roomId, 'bottom', i);
                    scored = true;
                } else {
                    puck.y = BOARD_SIZE - PUCK_RADIUS;
                    puck.vy *= -1;
                    roomState.events.push('wall');
                }
            }

            if (scored) continue;

            // マレットとの衝突
            for (let role of ROLES) {
                let p = roomState.players[role];
                if (p.active && !p.eliminated) {
                    let dx = puck.x - p.x;
                    let dy = puck.y - p.y;
                    let distance = Math.sqrt(dx * dx + dy * dy);
                    let minDist = PUCK_RADIUS + p.paddleRadius;

                    if (distance < minDist) {
                        let overlap = minDist - distance;
                        let nx = dx / distance;
                        let ny = dy / distance;
                        puck.x += nx * overlap;
                        puck.y += ny * overlap;

                        let mvx = mallet_v[role] ? mallet_v[role].vx : 0;
                        let mvy = mallet_v[role] ? mallet_v[role].vy : 0;
                        let mSpeed = Math.sqrt(mvx * mvx + mvy * mvy);

                        if (p.sp >= 100 && mSpeed > 3) {
                            p.sp = 0;
                            puck.isHyper = true;
                            roomState.events.push('hyper_smash');
                            puck.vx = nx * 35;
                            puck.vy = ny * 35;
                        } else {
                            p.sp = Math.min(100, p.sp + 10);
                            puck.isHyper = false;

                            let rvx = puck.vx - mvx;
                            let rvy = puck.vy - mvy;
                            let velAlongNormal = rvx * nx + rvy * ny;

                            if (velAlongNormal < 0) {
                                let e = 1.0;
                                let j = -(1 + e) * velAlongNormal;
                                // 最低限の跳ね返りを保証して完全停止を防ぐ
                                if (j < 6 && mSpeed > 1) j = 6;
                                puck.vx += j * nx;
                                puck.vy += j * ny;
                            }
                        }
                        
                        puck.lastHitter = role;
                        roomState.events.push('hit');
                        
                        // 衝突後の速度制限（壁抜け防止）
                        let postSpeed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
                        let postLimit = puck.isHyper ? 35 : 20;
                        if (postSpeed > postLimit) {
                            puck.vx = (puck.vx / postSpeed) * postLimit;
                            puck.vy = (puck.vy / postSpeed) * postLimit;
                        }
                    }

                    // バリア判定
                    if (p.barrierActive) {
                        let bX1, bY1, bX2, bY2;
                        if (role === 'bottom') { bX1 = goalStart; bX2 = goalEnd; bY1 = BOARD_SIZE - 120; bY2 = BOARD_SIZE - 120; }
                        if (role === 'top') { bX1 = goalStart; bX2 = goalEnd; bY1 = 120; bY2 = 120; }
                        if (role === 'left') { bY1 = goalStart; bY2 = goalEnd; bX1 = 120; bX2 = 120; }
                        if (role === 'right') { bY1 = goalStart; bY2 = goalEnd; bX1 = BOARD_SIZE - 120; bX2 = BOARD_SIZE - 120; }

                        if (role === 'bottom' || role === 'top') {
                            if (puck.x > bX1 - PUCK_RADIUS && puck.x < bX2 + PUCK_RADIUS) {
                                if (Math.abs(puck.y - bY1) < PUCK_RADIUS) {
                                    puck.y = role === 'bottom' ? bY1 - PUCK_RADIUS : bY1 + PUCK_RADIUS;
                                    puck.vy *= -1;
                                    roomState.events.push('wall');
                                }
                            }
                        } else {
                            if (puck.y > bY1 - PUCK_RADIUS && puck.y < bY2 + PUCK_RADIUS) {
                                if (Math.abs(puck.x - bX1) < PUCK_RADIUS) {
                                    puck.x = role === 'right' ? bX1 - PUCK_RADIUS : bX1 + PUCK_RADIUS;
                                    puck.vx *= -1;
                                    roomState.events.push('wall');
                                }
                            }
                        }
                    }
                }
            }

            // アイテムとの衝突
            for (let j = roomState.items.length - 1; j >= 0; j--) {
                let item = roomState.items[j];
                let dx = puck.x - item.x;
                let dy = puck.y - item.y;
                let distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < PUCK_RADIUS + ITEM_RADIUS) {
                    applyItemEffect(roomId, item.type, puck);
                    roomState.events.push('item_get');
                    roomState.items.splice(j, 1);
                }
            }
        }

        // ステータス効果の残り時間更新
        const now = Date.now();
        for (let role of ROLES) {
            let p = roomState.players[role];
            if (p.activeEffect) {
                let left = p.activeEffect.endTime - now;
                if (left <= 0) {
                    p.activeEffect = null;
                } else {
                    p.activeEffect.ratio = left / EFFECT_DURATION;
                }
            }
        }

        io.to(roomId).emit('game_state', roomState);
        roomState.events = [];
    }
}, INTERVAL);

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
