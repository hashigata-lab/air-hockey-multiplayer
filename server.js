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
const ROLES = ['bottom', 'top', 'left', 'right'];
const INITIAL_LIVES = 5;
const MIN_PLAYERS_TO_START = 2; // テストしやすくするため2人で開始可能に

// ルーム管理
const rooms = {};
const connectedClients = {}; // socket.id -> { roomId, role, name }

function createInitialGameState() {
    return {
        puck: { x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0 },
        players: {
            bottom: { x: BOARD_SIZE / 2, y: BOARD_SIZE - PADDLE_RADIUS - 20, active: false, id: null, name: '', color: '#ff4444', lives: INITIAL_LIVES, eliminated: false },
            top:    { x: BOARD_SIZE / 2, y: PADDLE_RADIUS + 20, active: false, id: null, name: '', color: '#4444ff', lives: INITIAL_LIVES, eliminated: false },
            left:   { x: PADDLE_RADIUS + 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#44ff44', lives: INITIAL_LIVES, eliminated: false },
            right:  { x: BOARD_SIZE - PADDLE_RADIUS - 20, y: BOARD_SIZE / 2, active: false, id: null, name: '', color: '#ffff44', lives: INITIAL_LIVES, eliminated: false }
        },
        status: 'WAITING',
        winner: null
    };
}

function resetPuck(roomState) {
    roomState.puck = { x: BOARD_SIZE / 2, y: BOARD_SIZE / 2, vx: 0, vy: 0 };
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
        resetPuck(roomState);
        io.to(roomId).emit('system_message', 'Game Started!');
    }
}

function handleGoal(roomId, role) {
    const roomState = rooms[roomId];
    if (!roomState || roomState.status !== 'PLAYING') return;

    let p = roomState.players[role];
    if (p.eliminated) return;

    p.lives--;
    io.to(roomId).emit('system_message', `${p.name || role.toUpperCase()} was scored on!`);

    if (p.lives <= 0) {
        p.eliminated = true;
        p.lives = 0;
        io.to(roomId).emit('system_message', `${p.name || role.toUpperCase()} is eliminated!`);
    }

    let aliveRoles = ROLES.filter(r => roomState.players[r].active && !roomState.players[r].eliminated);
    
    if (aliveRoles.length <= 1) {
        roomState.status = 'GAMEOVER';
        const winnerRole = aliveRoles.length === 1 ? aliveRoles[0] : null;
        const winnerName = winnerRole ? (roomState.players[winnerRole].name || winnerRole.toUpperCase()) : 'Draw';
        roomState.winner = winnerName;
        
        io.to(roomId).emit('system_message', `GAME OVER! Winner is ${winnerName}`);
        
        setTimeout(() => {
            if (rooms[roomId]) {
                rooms[roomId].status = 'WAITING';
                rooms[roomId].winner = null;
                resetPuck(rooms[roomId]);
                checkStartGame(roomId);
            }
        }, 5000);
    } else {
        setTimeout(() => {
            if (rooms[roomId]) resetPuck(rooms[roomId]);
        }, 1000);
    }
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, playerName }) => {
        if (connectedClients[socket.id]) return; // Already in a room

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
            
            if (role === 'bottom') {
                x = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
                y = Math.max(BOARD_SIZE / 2 + PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
            } else if (role === 'top') {
                x = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
                y = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE / 2 - PADDLE_RADIUS, y));
            } else if (role === 'left') {
                x = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE / 2 - PADDLE_RADIUS, x));
                y = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
            } else if (role === 'right') {
                x = Math.max(BOARD_SIZE / 2 + PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
                y = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
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
                        setTimeout(() => { if (rooms[roomId]) { rooms[roomId].status = 'WAITING'; resetPuck(rooms[roomId]); checkStartGame(roomId); } }, 5000);
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

        let puck = roomState.puck;
        puck.x += puck.vx;
        puck.y += puck.vy;

        puck.vx *= 0.99;
        puck.vy *= 0.99;

        if (Math.abs(puck.vx) < 0.1) puck.vx = 0;
        if (Math.abs(puck.vy) < 0.1) puck.vy = 0;

        const goalStart = (BOARD_SIZE - GOAL_SIZE) / 2;
        const goalEnd = goalStart + GOAL_SIZE;
        
        // ゴール判定 or 壁反射
        if (puck.x - PUCK_RADIUS < 0) {
            if (puck.y > goalStart && puck.y < goalEnd && !roomState.players['left'].eliminated) {
                handleGoal(roomId, 'left');
                puck.x = -100;
                puck.vx = 0; puck.vy = 0;
            } else {
                puck.x = PUCK_RADIUS;
                puck.vx *= -1;
            }
        } else if (puck.x + PUCK_RADIUS > BOARD_SIZE) {
            if (puck.y > goalStart && puck.y < goalEnd && !roomState.players['right'].eliminated) {
                handleGoal(roomId, 'right');
                puck.x = BOARD_SIZE + 100;
                puck.vx = 0; puck.vy = 0;
            } else {
                puck.x = BOARD_SIZE - PUCK_RADIUS;
                puck.vx *= -1;
            }
        }

        if (puck.y - PUCK_RADIUS < 0) {
            if (puck.x > goalStart && puck.x < goalEnd && !roomState.players['top'].eliminated) {
                handleGoal(roomId, 'top');
                puck.y = -100;
                puck.vx = 0; puck.vy = 0;
            } else {
                puck.y = PUCK_RADIUS;
                puck.vy *= -1;
            }
        } else if (puck.y + PUCK_RADIUS > BOARD_SIZE) {
            if (puck.x > goalStart && puck.x < goalEnd && !roomState.players['bottom'].eliminated) {
                handleGoal(roomId, 'bottom');
                puck.y = BOARD_SIZE + 100;
                puck.vx = 0; puck.vy = 0;
            } else {
                puck.y = BOARD_SIZE - PUCK_RADIUS;
                puck.vy *= -1;
            }
        }

        // マレットとの衝突
        for (let role of ROLES) {
            let player = roomState.players[role];
            if (player.active && !player.eliminated) {
                let dx = puck.x - player.x;
                let dy = puck.y - player.y;
                let distance = Math.sqrt(dx * dx + dy * dy);
                let minDist = PUCK_RADIUS + PADDLE_RADIUS;

                if (distance < minDist) {
                    let angle = Math.atan2(dy, dx);
                    puck.x = player.x + Math.cos(angle) * minDist;
                    puck.y = player.y + Math.sin(angle) * minDist;

                    let hitPower = 12;
                    puck.vx = Math.cos(angle) * hitPower;
                    puck.vy = Math.sin(angle) * hitPower;
                }
            }
        }

        io.to(roomId).emit('game_state', roomState);
    }
}, INTERVAL);

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
