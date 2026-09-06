const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ゲームの論理サイズと定数
const BOARD_SIZE = 800;
const GOAL_SIZE = 240;
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

function createInitialGameState() {
    return {
        events: [],
        pucks: [{ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null }],
        items: [],
        itemSpawnTimer: 0,
        players: {
            bottom: { x: BOARD_SIZE / 2, y: BOARD_SIZE - PADDLE_RADIUS - 20, active: false, id: null, name: '', color: '#ff4444', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null },
            top:    { x: BOARD_SIZE / 2, y: PADDLE_RADIUS + 20, active: false, id: null, name: '', color: '#4444ff', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null },
            left:   { x: PADDLE_RADIUS + 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#44ff44', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null },
            right:  { x: BOARD_SIZE - PADDLE_RADIUS - 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#ffff44', lives: INITIAL_LIVES, eliminated: false, paddleRadius: PADDLE_RADIUS, barrierActive: false, activeEffect: null }
        },
        status: 'WAITING',
        winner: null
    };
}

function resetPucks(roomState) {
    roomState.events = [];
    roomState.pucks = [{ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null }];
    roomState.items = [];
    roomState.itemSpawnTimer = 0;
    
    // reset player statuses
    for (let role of ROLES) {
        roomState.players[role].paddleRadius = PADDLE_RADIUS;
        roomState.players[role].barrierActive = false;
        roomState.players[role].activeEffect = null;
    }
}

function getActivePlayersCount(roomState) {
    return ROLES.filter(r => roomState.players[r].active).length;
}

function checkStartGame(roomId) {
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

function handleGoal(roomId, role, puckIndex) {
    const roomState = rooms[roomId];
    if (!roomState || roomState.status !== 'PLAYING') return;

    roomState.events.push('goal');

    let p = roomState.players[role];
    if (!p.eliminated) {
        p.lives--;
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
        roomState.status = 'GAMEOVER';
        roomState.events.push('gameover');
        const winnerRole = aliveRoles.length === 1 ? aliveRoles[0] : null;
        const winnerName = winnerRole ? (roomState.players[winnerRole].name || winnerRole.toUpperCase()) : 'Draw';
        roomState.winner = winnerName;
        
        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
        
        setTimeout(() => {
            if (rooms[roomId]) {
                rooms[roomId].status = 'WAITING';
                rooms[roomId].winner = null;
                resetPucks(rooms[roomId]);
                checkStartGame(roomId);
            }
        }, 5000);
    } else {
        if (roomState.pucks.length === 0) {
            setTimeout(() => {
                if (rooms[roomId] && rooms[roomId].status === 'PLAYING') {
                    rooms[roomId].pucks.push({ x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0, lastHitter: null });
                }
            }, 1000);
        }
    }
}

function applyItemEffect(roomId, type, puck) {
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
                lastHitter: null
            });
            break;
    }
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, playerName }) => {
        if (connectedClients[socket.id]) return; 

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = createInitialGameState();
        }
        
        const roomState = rooms[roomId];
        let assignedRole = null;
        
        for (let role of ROLES) {
            if (!roomState.players[role].active) {
                assignedRole = role;
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
            checkStartGame(roomId);
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

    socket.on('player_input', (data) => {
        const clientInfo = connectedClients[socket.id];
        if (!clientInfo || !clientInfo.role) return;

        const roomState = rooms[clientInfo.roomId];
        const role = clientInfo.role;

        if (roomState && roomState.players[role] && !roomState.players[role].eliminated) {
            let x = data.x;
            let y = data.y;
            let pr = roomState.players[role].paddleRadius;
            
            if (role === 'bottom') {
                x = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
                y = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, y));
            } else if (role === 'top') {
                x = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
                y = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, y));
            } else if (role === 'left') {
                x = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, x));
                y = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
            } else if (role === 'right') {
                x = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, x));
                y = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
            }

            roomState.players[role].x = x;
            roomState.players[role].y = y;
        }
    });

    socket.on('disconnect', () => {
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
                
                if (role === 'bottom') { roomState.players[role].x = BOARD_SIZE/2; roomState.players[role].y = BOARD_SIZE - PADDLE_RADIUS - 20; }
                if (role === 'top')    { roomState.players[role].x = BOARD_SIZE/2; roomState.players[role].y = PADDLE_RADIUS + 20; }
                if (role === 'left')   { roomState.players[role].x = PADDLE_RADIUS + 20; roomState.players[role].y = BOARD_SIZE/2; }
                if (role === 'right')  { roomState.players[role].x = BOARD_SIZE - PADDLE_RADIUS - 20; roomState.players[role].y = BOARD_SIZE/2; }
                
                io.to(roomId).emit('system_message', `${roomState.players[role].name} left the game.`);

                if (roomState.status === 'PLAYING') {
                    let aliveRoles = ROLES.filter(r => roomState.players[r].active && !roomState.players[r].eliminated);
                    if (aliveRoles.length <= 1) {
                        roomState.status = 'GAMEOVER';
                        const winnerRole = aliveRoles.length === 1 ? aliveRoles[0] : null;
                        const winnerName = winnerRole ? (roomState.players[winnerRole].name || winnerRole.toUpperCase()) : 'Draw';
                        roomState.winner = winnerName;
                        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
                        setTimeout(() => { if (rooms[roomId]) { rooms[roomId].status = 'WAITING'; resetPucks(rooms[roomId]); checkStartGame(roomId); } }, 5000);
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

        for (let i = roomState.pucks.length - 1; i >= 0; i--) {
            let puck = roomState.pucks[i];
            let scored = false;

            puck.x += puck.vx;
            puck.y += puck.vy;

            puck.vx *= 0.99;
            puck.vy *= 0.99;

            if (Math.abs(puck.vx) < 0.1) puck.vx = 0;
            if (Math.abs(puck.vy) < 0.1) puck.vy = 0;

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
                let player = roomState.players[role];
                if (player.active && !player.eliminated) {
                    let dx = puck.x - player.x;
                    let dy = puck.y - player.y;
                    let distance = Math.sqrt(dx * dx + dy * dy);
                    let minDist = PUCK_RADIUS + player.paddleRadius;

                    if (distance < minDist) {
                        let angle = Math.atan2(dy, dx);
                        puck.x = player.x + Math.cos(angle) * minDist;
                        puck.y = player.y + Math.sin(angle) * minDist;

                        let hitPower = 12;
                        puck.vx = Math.cos(angle) * hitPower;
                        puck.vy = Math.sin(angle) * hitPower;
                        puck.lastHitter = role;
                        roomState.events.push('hit');
                    }

                    // バリア判定
                    if (player.barrierActive) {
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
