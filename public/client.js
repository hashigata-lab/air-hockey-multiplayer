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
    currentRoomId = roomId;
    const playerName = playerNameInput.value.trim() || 'Guest';
    
    // URLを更新
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', roomId);
    window.history.pushState({ path: newUrl.href }, '', newUrl.href);

    lobbyDiv.style.display = 'none';
    gameContainer.style.display = 'block';
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
    
    // クライアント側でも壁の制限をかける（予測描画用）
    if (myRole === 'bottom') {
        boundedX = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
        boundedY = Math.max(BOARD_SIZE / 2 + PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
    } else if (myRole === 'top') {
        boundedX = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
        boundedY = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE / 2 - PADDLE_RADIUS, y));
    } else if (myRole === 'left') {
        boundedX = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE / 2 - PADDLE_RADIUS, x));
        boundedY = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
    } else if (myRole === 'right') {
        boundedX = Math.max(BOARD_SIZE / 2 + PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, x));
        boundedY = Math.max(PADDLE_RADIUS, Math.min(BOARD_SIZE - PADDLE_RADIUS, y));
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
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const goalStart = (BOARD_SIZE - GOAL_SIZE) / 2;
    const goalEnd = goalStart + GOAL_SIZE;

    const getGoalColor = (role, defaultColor) => {
        if (serverState && serverState.players[role] && serverState.players[role].eliminated) {
            return '#fff';
        }
        return defaultColor;
    };

    const drawWall = (x1, y1, x2, y2, color, isGoal = false) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = isGoal ? 15 : 8;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    };

    drawWall(0, 0, goalStart, 0, '#fff');
    drawWall(goalStart, 0, goalEnd, 0, getGoalColor('top', '#4444ff'), true);
    drawWall(goalEnd, 0, BOARD_SIZE, 0, '#fff');

    drawWall(0, BOARD_SIZE, goalStart, BOARD_SIZE, '#fff');
    drawWall(goalStart, BOARD_SIZE, goalEnd, BOARD_SIZE, getGoalColor('bottom', '#ff4444'), true);
    drawWall(goalEnd, BOARD_SIZE, BOARD_SIZE, BOARD_SIZE, '#fff');

    drawWall(0, 0, 0, goalStart, '#fff');
    drawWall(0, goalStart, 0, goalEnd, getGoalColor('left', '#44ff44'), true);
    drawWall(0, goalEnd, 0, BOARD_SIZE, '#fff');

    drawWall(BOARD_SIZE, 0, BOARD_SIZE, goalStart, '#fff');
    drawWall(BOARD_SIZE, goalStart, BOARD_SIZE, goalEnd, getGoalColor('right', '#ffff44'), true);
    drawWall(BOARD_SIZE, goalEnd, BOARD_SIZE, BOARD_SIZE, '#fff');

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
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

function drawPuck(x, y) {
    drawCircle(x, y, PUCK_RADIUS, '#ddd');
}

function drawPaddle(x, y, color, isMe) {
    drawCircle(x, y, PADDLE_RADIUS, color, isMe);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(x, y, PADDLE_RADIUS * 0.4, 0, Math.PI * 2);
    ctx.fill();
}

function drawUI() {
    if (!serverState) return;

    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    
    const p = serverState.players;
    if (p.top.active) ctx.fillText(`💙 ${p.top.lives} ${p.top.name}`, BOARD_SIZE/2, 40);
    if (p.bottom.active) ctx.fillText(`❤️ ${p.bottom.lives} ${p.bottom.name}`, BOARD_SIZE/2, BOARD_SIZE - 20);
    if (p.left.active) ctx.fillText(`💚 ${p.left.lives} ${p.left.name}`, 150, BOARD_SIZE/2);
    if (p.right.active) ctx.fillText(`💛 ${p.right.lives} ${p.right.name}`, BOARD_SIZE - 150, BOARD_SIZE/2);

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

    drawBoard();

    if (serverState) {
        for (const role in serverState.players) {
            const p = serverState.players[role];
            if (p.active && !p.eliminated) {
                if (role === myRole) {
                    // 自分のマレットはサーバーの応答を待たずにローカル座標で描画（ラグ対策）
                    drawPaddle(localPaddle.x, localPaddle.y, p.color, true);
                } else {
                    drawPaddle(p.x, p.y, p.color, false);
                }
            }
        }
        
        if (serverState.puck.x > 0 && serverState.puck.x < BOARD_SIZE &&
            serverState.puck.y > 0 && serverState.puck.y < BOARD_SIZE) {
            drawPuck(serverState.puck.x, serverState.puck.y);
        }
    }

    drawUI();

    requestAnimationFrame(gameLoop);
}

gameLoop();
