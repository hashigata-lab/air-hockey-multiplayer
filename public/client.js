const socket = io({ autoConnect: false }); // ロビーでJoinするまで接続しない

const lobbyDiv = document.getElementById('lobby');
const gameContainer = document.getElementById('game-container');
const chatContainer = document.getElementById('chat-container');

const playerNameInput = document.getElementById('playerName');
const roomIdInput = document.getElementById('roomIdInput');
const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');

const statusText = document.getElementById('status');
const debugInfo = document.getElementById('debug-info');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnChatSend = document.getElementById('chat-send');

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const BOARD_SIZE = 800;
const GOAL_SIZE = 240;
const PUCK_RADIUS = 15;
const PADDLE_RADIUS = 35;
const ITEM_RADIUS = 20;

let audioCtx = null;
let shakeFrames = 0;
let flashFrames = 0;
let puckTrails = [];
let isGameLoopRunning = false;

const bgImages = {
    CYBERPUNK: new Image(),
    RETRO: new Image(),
    ICE: new Image()
};
bgImages.CYBERPUNK.src = 'assets/bg_cyberpunk.jpg';
bgImages.RETRO.src = 'assets/bg_retro.jpg';
bgImages.ICE.src = 'assets/bg_ice.jpg';

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playSound(type) {
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    const now = audioCtx.currentTime;

    if (type === 'hit') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(300, now + 0.1);
        gainNode.gain.setValueAtTime(0.15, now);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'wall') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'goal') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.setValueAtTime(120, now + 0.2);
        gainNode.gain.setValueAtTime(0.3, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.8);
        osc.start(now);
        osc.stop(now + 0.8);
    } else if (type === 'item_spawn') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.setValueAtTime(800, now + 0.1);
        osc.frequency.setValueAtTime(1200, now + 0.2);
        gainNode.gain.setValueAtTime(0.15, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
    } else if (type === 'item_get') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.2);
        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'gameover') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        gainNode.gain.setValueAtTime(0.3, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 1.5);
        osc.start(now);
        osc.stop(now + 1.5);
    } else if (type === 'hyper_smash') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(10, now + 0.5);
        gainNode.gain.setValueAtTime(0.6, now);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
    }
}

let serverState = null;
let myRole = null;
let currentRoomId = null;
let localPaddle = { x: 0, y: 0 }; // ローカルで予測描画するためのマレット座標

// URLからroomIdを取得
const urlParams = new URLSearchParams(window.location.search);
const urlRoomId = urlParams.get('room');
if (urlRoomId) {
    roomIdInput.value = urlRoomId;
}

function generateRandomRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function joinGame(roomId) {
    initAudio();
    currentRoomId = roomId;
    const playerName = playerNameInput.value.trim() || 'Guest';
    
    // URLを更新
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', roomId);
    window.history.pushState({ path: newUrl.href }, '', newUrl.href);

    lobbyDiv.style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'block';
    document.getElementById('lobby-room-id').innerText = currentRoomId;
    gameContainer.style.display = 'none';
    chatContainer.style.display = 'flex';

    socket.connect();
    
    socket.on('connect', () => {
        statusText.innerText = `Connected! Room: ${roomId}`;
        socket.emit('join_room', { roomId, playerName });
    });
}

btnCreateRoom.addEventListener('click', () => {
    const roomId = generateRandomRoomId();
    joinGame(roomId);
});

btnJoinRoom.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (roomId) {
        joinGame(roomId);
    } else {
        alert("Please enter a Room ID");
    }
});

// Chat logic
function sendChat() {
    const msg = chatInput.value.trim();
    if (msg) {
        socket.emit('chat_message', msg);
        chatInput.value = '';
    }
}
btnChatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
});

document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('start_game');
});

document.querySelectorAll('.stage-option').forEach(el => {
    el.addEventListener('click', () => {
        const stage = el.getAttribute('data-stage');
        socket.emit('change_stage', stage);
    });
});

socket.on('chat_message', (data) => {
    const p = document.createElement('div');
    p.innerText = `${data.name}: ${data.message}`;
    p.style.marginBottom = '5px';
    chatMessages.appendChild(p);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});


socket.on('disconnect', () => {
    statusText.innerText = 'Disconnected from server.';
    serverState = null;
    myRole = null;
});

socket.on('assigned_role', (role) => {
    myRole = role;
    statusText.innerText = `Your Role: ${role.toUpperCase()} (Room: ${currentRoomId})`;
});

socket.on('spectator', () => {
    myRole = null;
    statusText.innerText = `Spectating (Room is Full)`;
});

socket.on('system_message', (msg) => {
    debugInfo.innerText = msg;
    // チャット欄にもシステムメッセージを表示
    const p = document.createElement('div');
    p.innerText = `[System] ${msg}`;
    p.style.color = '#aaa';
    p.style.marginBottom = '5px';
    chatMessages.appendChild(p);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

socket.on('game_state', (state) => {
    serverState = state;
    
    if (state.status === 'WAITING') {
        const p = state.players;
        let activeCount = 0;
        let listHtml = '';
        ['top', 'bottom', 'left', 'right'].forEach(role => {
            if (p[role].active) {
                activeCount++;
                listHtml += `<li><span style="color: ${p[role].color}">${p[role].name || role}</span> <span>(${role})</span></li>`;
            }
        });
        
        const lobbyPlayerList = document.getElementById('lobby-player-list');
        if (lobbyPlayerList) lobbyPlayerList.innerHTML = listHtml;
        const lobbyPlayerCount = document.getElementById('lobby-player-count');
        if (lobbyPlayerCount) lobbyPlayerCount.innerText = activeCount;
        const btnStart = document.getElementById('btn-start-game');
        if (btnStart) btnStart.disabled = (activeCount < 2);
        
        if (state.stage) {
            document.querySelectorAll('.stage-option').forEach(el => {
                if (el.getAttribute('data-stage') === state.stage) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });
        }
    } else if (state.status === 'PLAYING') {
        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen && lobbyScreen.style.display === 'block') {
            lobbyScreen.style.display = 'none';
            document.getElementById('game-container').style.display = 'block';
        }
        if (!isGameLoopRunning) {
            isGameLoopRunning = true;
            gameLoop();
        }
    }

    if (state.events && state.events.length > 0) {
        state.events.forEach(ev => {
            playSound(ev);
            if (ev === 'hyper_smash') {
                shakeFrames = 25;
                flashFrames = 5;
            }
            if (ev === 'wall' && state.pucks.some(p => p.isHyper)) shakeFrames = 3;
        });
    }
});

function handleInput(clientX, clientY) {
    if (!myRole) return;
    
    if (serverState && serverState.players[myRole] && serverState.players[myRole].eliminated) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    
    let boundedX = x;
    let boundedY = y;
    
    let pr = serverState && serverState.players[myRole] ? serverState.players[myRole].paddleRadius : PADDLE_RADIUS;
    
    // クライアント側でも壁の制限をかける（予測描画用）
    if (myRole === 'bottom') {
        boundedX = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
        boundedY = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, y));
    } else if (myRole === 'top') {
        boundedX = Math.max(pr, Math.min(BOARD_SIZE - pr, x));
        boundedY = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, y));
    } else if (myRole === 'left') {
        boundedX = Math.max(pr, Math.min(BOARD_SIZE / 2 - pr, x));
        boundedY = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
    } else if (myRole === 'right') {
        boundedX = Math.max(BOARD_SIZE / 2 + pr, Math.min(BOARD_SIZE - pr, x));
        boundedY = Math.max(pr, Math.min(BOARD_SIZE - pr, y));
    }
    
    localPaddle.x = boundedX;
    localPaddle.y = boundedY;

    socket.emit('player_input', { x: boundedX, y: boundedY });
}

canvas.addEventListener('mousemove', (e) => handleInput(e.clientX, e.clientY));
canvas.addEventListener('touchmove', (e) => {
    e.preventDefault(); 
    handleInput(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });

function drawBoard() {
    const stage = (serverState && serverState.stage) ? serverState.stage : 'CYBERPUNK';
    
    // 背景画像の描画
    if (bgImages[stage] && bgImages[stage].complete) {
        ctx.drawImage(bgImages[stage], 0, 0, BOARD_SIZE, BOARD_SIZE);
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);
    } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);
    }

    let centerLineColor = 'rgba(255, 255, 255, 0.2)';
    let defaultWallColor = '#fff';
    
    if (stage === 'CYBERPUNK') {
        centerLineColor = 'rgba(0, 255, 255, 0.3)';
    } else if (stage === 'RETRO') {
        centerLineColor = 'rgba(255, 100, 0, 0.4)';
        defaultWallColor = '#ff6600';
    } else if (stage === 'ICE') {
        centerLineColor = 'rgba(200, 255, 255, 0.5)';
        defaultWallColor = '#aaffff';
    }

    const goalStart = (BOARD_SIZE - GOAL_SIZE) / 2;
    const goalEnd = goalStart + GOAL_SIZE;

    const getGoalColor = (role, defaultColor) => {
        if (serverState && serverState.players[role] && serverState.players[role].eliminated) {
            return defaultWallColor;
        }
        return defaultColor;
    };

    const drawWall = (x1, y1, x2, y2, color, isGoal = false) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = isGoal ? 10 : 6;
        if (stage === 'RETRO' && !isGoal) {
            ctx.shadowBlur = 4;
            ctx.shadowColor = color;
        } else if (stage === 'CYBERPUNK' && !isGoal) {
            ctx.shadowBlur = 2;
            ctx.shadowColor = '#00ffff';
        } else if (stage === 'ICE' && !isGoal) {
            ctx.shadowBlur = 6;
            ctx.shadowColor = '#ffffff';
        }
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.shadowBlur = 0;
    };

    drawWall(0, 0, goalStart, 0, defaultWallColor);
    drawWall(goalStart, 0, goalEnd, 0, getGoalColor('top', '#4444ff'), true);
    drawWall(goalEnd, 0, BOARD_SIZE, 0, defaultWallColor);

    drawWall(0, BOARD_SIZE, goalStart, BOARD_SIZE, defaultWallColor);
    drawWall(goalStart, BOARD_SIZE, goalEnd, BOARD_SIZE, getGoalColor('bottom', '#ff4444'), true);
    drawWall(goalEnd, BOARD_SIZE, BOARD_SIZE, BOARD_SIZE, defaultWallColor);

    drawWall(0, 0, 0, goalStart, defaultWallColor);
    drawWall(0, goalStart, 0, goalEnd, getGoalColor('left', '#44ff44'), true);
    drawWall(0, goalEnd, 0, BOARD_SIZE, defaultWallColor);

    drawWall(BOARD_SIZE, 0, BOARD_SIZE, goalStart, defaultWallColor);
    drawWall(BOARD_SIZE, goalStart, BOARD_SIZE, goalEnd, getGoalColor('right', '#ffff44'), true);
    drawWall(BOARD_SIZE, goalEnd, BOARD_SIZE, BOARD_SIZE, defaultWallColor);

    ctx.strokeStyle = centerLineColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, BOARD_SIZE / 2);
    ctx.lineTo(BOARD_SIZE, BOARD_SIZE / 2);
    ctx.moveTo(BOARD_SIZE / 2, 0);
    ctx.lineTo(BOARD_SIZE / 2, BOARD_SIZE);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(BOARD_SIZE / 2, BOARD_SIZE / 2, 100, 0, Math.PI * 2);
    ctx.stroke();
}

function drawCircle(x, y, radius, color, isMe = false) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = isMe ? '#fff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = isMe ? 6 : 4;
    ctx.stroke();
}

function drawPuck(puck, i) {
    if (puck.isHyper) {
        if (puckTrails[i] && puckTrails[i].length > 1) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (let j = 0; j < puckTrails[i].length - 1; j++) {
                const t1 = puckTrails[i][j];
                const t2 = puckTrails[i][j + 1];
                ctx.beginPath();
                ctx.moveTo(t1.x, t1.y);
                ctx.lineTo(t2.x, t2.y);
                ctx.strokeStyle = `rgba(255, 100, 0, ${t1.life})`;
                ctx.lineWidth = (PUCK_RADIUS * 1.5) * t1.life;
                ctx.stroke();
            }
        }
        
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ff3300';
        drawCircle(puck.x, puck.y, PUCK_RADIUS, '#ffaa00');
        ctx.shadowBlur = 0;
    } else {
        drawCircle(puck.x, puck.y, PUCK_RADIUS, '#ddd');
    }
}

function drawPaddle(x, y, color, isMe, radius, sp = 0) {
    if (sp >= 100) {
        ctx.save();
        ctx.translate(x, y);
        const time = Date.now() / 150;
        ctx.rotate(time);
        ctx.shadowBlur = 10;
        ctx.shadowColor = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        const spikes = 12;
        const outer = radius + 15;
        const inner = radius + 5;
        for (let k = 0; k < spikes * 2; k++) {
            const angle = (k * Math.PI) / spikes;
            const r = (k % 2 === 0) ? outer : inner;
            if (k === 0) ctx.moveTo(r * Math.cos(angle), r * Math.sin(angle));
            else ctx.lineTo(r * Math.cos(angle), r * Math.sin(angle));
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    drawCircle(x, y, radius, color, isMe);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();
}

function drawBarrier(role) {
    const goalStart = (BOARD_SIZE - GOAL_SIZE) / 2;
    const goalEnd = goalStart + GOAL_SIZE;
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    if (role === 'bottom') { ctx.moveTo(goalStart, BOARD_SIZE - 120); ctx.lineTo(goalEnd, BOARD_SIZE - 120); }
    if (role === 'top') { ctx.moveTo(goalStart, 120); ctx.lineTo(goalEnd, 120); }
    if (role === 'left') { ctx.moveTo(120, goalStart); ctx.lineTo(120, goalEnd); }
    if (role === 'right') { ctx.moveTo(BOARD_SIZE - 120, goalStart); ctx.lineTo(BOARD_SIZE - 120, goalEnd); }
    
    ctx.shadowBlur = 5;
    ctx.shadowColor = '#00ffff';
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawItem(x, y, type) {
    let color = '#fff';
    let icon = '?';
    if (type === 'SIZE_UP') { color = '#44ff44'; icon = '🍄'; }
    if (type === 'SIZE_DOWN') { color = '#ff44ff'; icon = '☠️'; }
    if (type === 'BARRIER') { color = '#44ccff'; icon = '🛡️'; }
    if (type === 'SPEED_UP') { color = '#ff4444'; icon = '⚡'; }
    if (type === 'MULTI_PUCK') { color = '#ffff44'; icon = '☄️'; }

    const scale = 1 + Math.sin(Date.now() / 200) * 0.1;
    const currentRadius = ITEM_RADIUS * scale;

    ctx.save();
    ctx.shadowBlur = 5;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, currentRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#000';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, x, y + 2);
    ctx.restore();
}

function drawUI() {
    if (!serverState) return;

    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    
    function getHearts(lives, colorHeart) {
        let str = '';
        const maxLives = 5;
        for (let i = 0; i < maxLives; i++) {
            str += i < lives ? colorHeart : '🖤';
        }
        return str;
    }

    function getEffectIcon(type) {
        if (type === 'SIZE_UP') return '🍄';
        if (type === 'SIZE_DOWN') return '☠️';
        if (type === 'BARRIER') return '🛡️';
        return '';
    }

    function drawEffectRing(effect) {
        if (!effect) return;
        const icon = getEffectIcon(effect.type);
        if (!icon) return;

        const offsetX = 130;
        ctx.font = '20px sans-serif';
        ctx.fillText(icon, offsetX, 2);

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 4;
        ctx.arc(offsetX, 0, 16, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 4;
        ctx.arc(offsetX, 0, 16, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * effect.ratio));
        ctx.stroke();
    }

    function drawSPGauge(sp) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(-50, 45, 100, 8);
        
        if (sp >= 100) {
            ctx.shadowBlur = 5;
            ctx.shadowColor = '#ffff00';
            ctx.fillStyle = '#ffff00';
        } else {
            ctx.fillStyle = '#ff8800';
        }
        ctx.fillRect(-50, 45, sp, 8);
        ctx.shadowBlur = 0;
    }

    const p = serverState.players;
    
    if (p.top.active) {
        ctx.save();
        ctx.translate(BOARD_SIZE/2, 35);
        ctx.fillText(`${p.top.name} ${getHearts(p.top.lives, '💙')}`, 0, 0);
        drawEffectRing(p.top.activeEffect);
        drawSPGauge(p.top.sp);
        ctx.restore();
    }
    
    if (p.bottom.active) {
        ctx.save();
        ctx.translate(BOARD_SIZE/2, BOARD_SIZE - 20);
        ctx.fillText(`${p.bottom.name} ${getHearts(p.bottom.lives, '❤️')}`, 0, 0);
        drawEffectRing(p.bottom.activeEffect);
        drawSPGauge(p.bottom.sp);
        ctx.restore();
    }
    
    if (p.left.active) {
        ctx.save();
        ctx.translate(35, BOARD_SIZE/2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`${p.left.name} ${getHearts(p.left.lives, '💚')}`, 0, 0);
        drawEffectRing(p.left.activeEffect);
        drawSPGauge(p.left.sp);
        ctx.restore();
    }
    
    if (p.right.active) {
        ctx.save();
        ctx.translate(BOARD_SIZE - 35, BOARD_SIZE/2);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(`${p.right.name} ${getHearts(p.right.lives, '💛')}`, 0, 0);
        drawEffectRing(p.right.activeEffect);
        drawSPGauge(p.right.sp);
        ctx.restore();
    }

    if (serverState.status === 'WAITING') {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, BOARD_SIZE/2 - 50, BOARD_SIZE, 100);
        ctx.fillStyle = '#fff';
        ctx.font = '32px sans-serif';
        ctx.fillText(`Waiting for players... (Need 2+)`, BOARD_SIZE/2, BOARD_SIZE/2 + 10);
    } else if (serverState.status === 'GAMEOVER') {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, BOARD_SIZE/2 - 60, BOARD_SIZE, 120);
        ctx.fillStyle = '#ffdd44';
        ctx.font = '40px sans-serif';
        ctx.fillText(`WINNER: ${serverState.winner}`, BOARD_SIZE/2, BOARD_SIZE/2);
        ctx.fillStyle = '#fff';
        ctx.font = '20px sans-serif';
        ctx.fillText('Restarting soon...', BOARD_SIZE/2, BOARD_SIZE/2 + 40);
    }
}

function gameLoop() {
    // Canvasが表示されていない時は描画処理をスキップ
    if (gameContainer.style.display !== 'block') {
        requestAnimationFrame(gameLoop);
        return;
    }

    ctx.save();
    if (shakeFrames > 0) {
        let maxShake = (shakeFrames / 15) * 15;
        ctx.translate((Math.random() - 0.5) * maxShake, (Math.random() - 0.5) * maxShake);
        shakeFrames--;
    }

    drawBoard();

    if (serverState) {
        // Trail update
        if (serverState.pucks) {
            for (let i = 0; i < serverState.pucks.length; i++) {
                let p = serverState.pucks[i];
                if (!puckTrails[i]) puckTrails[i] = [];
                if (p.isHyper) {
                    puckTrails[i].push({ x: p.x, y: p.y, life: 1.0 });
                    if (puckTrails[i].length > 10) puckTrails[i].shift();
                } else {
                    puckTrails[i] = [];
                }
            }
        }
        for (let i = 0; i < puckTrails.length; i++) {
            for (let j = puckTrails[i].length - 1; j >= 0; j--) {
                puckTrails[i][j].life -= 0.1;
                if (puckTrails[i][j].life <= 0) puckTrails[i].splice(j, 1);
            }
        }

        if (serverState.items) {
            for (let item of serverState.items) {
                drawItem(item.x, item.y, item.type);
            }
        }
        
        // プレイヤーとバリアの描画
        for (const role in serverState.players) {
            const p = serverState.players[role];
            if (p.active && !p.eliminated) {
                if (p.barrierActive) drawBarrier(role);
                
                if (role === myRole) {
                    drawPaddle(localPaddle.x, localPaddle.y, p.color, true, p.paddleRadius, p.sp);
                } else {
                    drawPaddle(p.x, p.y, p.color, false, p.paddleRadius, p.sp);
                }
            }
        }
        
        if (serverState.pucks) {
            for (let i = 0; i < serverState.pucks.length; i++) {
                let puck = serverState.pucks[i];
                if (puck.x > 0 && puck.x < BOARD_SIZE && puck.y > 0 && puck.y < BOARD_SIZE) {
                    drawPuck(puck, i);
                }
            }
        }
    }

    drawUI();

    if (flashFrames > 0) {
        ctx.fillStyle = `rgba(255, 255, 255, ${flashFrames / 5})`;
        ctx.fillRect(-50, -50, BOARD_SIZE + 100, BOARD_SIZE + 100);
        flashFrames--;
    }

    ctx.restore();

    requestAnimationFrame(gameLoop);
}

gameLoop();
