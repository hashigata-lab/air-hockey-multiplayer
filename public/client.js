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

let BOARD_SIZE = 800;
let GOAL_SIZE = 240;
const PUCK_RADIUS = 15;
const PADDLE_RADIUS = 35;
const ITEM_RADIUS = 20;

let audioCtx = null;
let shakeFrames = 0;
let flashFrames = 0;
let puckTrails = [];
let isGameLoopRunning = false;

const bgImages = {
    CHAOS_VOID: new Image(),
    BLOOD_MOON: new Image(),
    ABYSSAL_ICE: new Image()
};
bgImages.CHAOS_VOID.src = 'assets/bg_chaos_void.jpg';
bgImages.BLOOD_MOON.src = 'assets/bg_blood_moon.jpg';
bgImages.ABYSSAL_ICE.src = 'assets/bg_abyssal_ice.jpg';

const skinImages = {
    DOGE: new Image(),
    CAT: new Image(),
    FROG: new Image()
};
skinImages.DOGE.src = 'assets/skin_doge.jpg';
skinImages.CAT.src = 'assets/skin_cat.jpg';
skinImages.FROG.src = 'assets/skin_frog.jpg';

const itemImages = {
    SIZE_UP: new Image(),
    SIZE_DOWN: new Image(),
    BARRIER: new Image(),
    SPEED_UP: new Image(),
    MULTI_PUCK: new Image()
};
itemImages.SIZE_UP.src = 'assets/item_size_up.jpg';
itemImages.SIZE_DOWN.src = 'assets/item_size_down.jpg';
itemImages.BARRIER.src = 'assets/item_barrier.jpg';
itemImages.SPEED_UP.src = 'assets/item_speed_up.jpg';
itemImages.MULTI_PUCK.src = 'assets/item_multi_puck.jpg';

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

let isMuted = false;
let seVolume = parseFloat(localStorage.getItem('seVolume'));
if (isNaN(seVolume)) seVolume = 1.0;

const bgmController = {
    audioElements: {
        WAITING: new Audio('assets/bgm_lobby.mp3'),
        CHAOS_VOID: new Audio('assets/bgm_cyberpunk.mp3'),
        BLOOD_MOON: new Audio('assets/bgm_retro.mp3'),
        ABYSSAL_ICE: new Audio('assets/bgm_ice.mp3')
    },
    currentTheme: null,
    hasStarted: false,
    volume: 0.4,
    analyserNode: null,
    freqData: null,
    bgmGain: null,
    
    init() {
        let savedVol = parseFloat(localStorage.getItem('bgmVolume'));
        if (!isNaN(savedVol)) this.volume = savedVol;
        for (let key in this.audioElements) {
            this.audioElements[key].loop = true;
            this.audioElements[key].volume = this.volume;
        }
    },

    initWebAudio() {
        if (this.analyserNode) return;
        
        this.bgmGain = audioCtx.createGain();
        this.bgmGain.gain.value = this.volume;
        
        this.analyserNode = audioCtx.createAnalyser();
        this.analyserNode.fftSize = 256;
        this.freqData = new Uint8Array(this.analyserNode.frequencyBinCount);
        
        this.bgmGain.connect(this.analyserNode);
        this.analyserNode.connect(audioCtx.destination);

        for (let key in this.audioElements) {
            const source = audioCtx.createMediaElementSource(this.audioElements[key]);
            source.connect(this.bgmGain);
        }
    },
    
    updateVolume(vol) {
        this.volume = vol;
        if (this.bgmGain) {
            this.bgmGain.gain.value = vol;
        } else {
            for (let key in this.audioElements) {
                this.audioElements[key].volume = this.volume;
            }
        }
        localStorage.setItem('bgmVolume', vol);
    },
    
    play(theme) {
        if (!this.hasStarted) return;
        if (this.currentTheme === theme) return;
        
        if (this.currentTheme && this.audioElements[this.currentTheme]) {
            this.audioElements[this.currentTheme].pause();
            this.audioElements[this.currentTheme].currentTime = 0;
        }
        
        this.currentTheme = theme;
        if (!isMuted && this.audioElements[theme]) {
            this.audioElements[theme].play().catch(e => console.log('Autoplay prevented', e));
        }
    },
    
    updateMute() {
        for (let key in this.audioElements) {
            this.audioElements[key].muted = isMuted;
        }
        if (!isMuted && this.currentTheme && this.audioElements[this.currentTheme].paused) {
            this.audioElements[this.currentTheme].play().catch(e => console.log('Autoplay prevented', e));
        }
    }
};
bgmController.init();

document.getElementById('btn-mute').addEventListener('click', (e) => {
    isMuted = !isMuted;
    e.target.innerText = isMuted ? '🔇' : '🎵';
    e.target.classList.toggle('muted', isMuted);
    bgmController.updateMute();
});


// --- Account & Rank Logic ---
let currentUser = null;
let currentRating = 1000;

async function checkAuth() {
    const token = localStorage.getItem('auth_token');
    if (token) {
        try {
            const res = await fetch('/api/me', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            const data = await res.json();
            if (res.ok) {
                currentUser = data.username;
                currentRating = data.rating;
                document.getElementById('playerName').value = currentUser;
                document.getElementById('playerName').disabled = true;
                updateAuthStatus();
            } else {
                localStorage.removeItem('auth_token');
            }
        } catch (e) { console.error(e); }
    }
}

function getRankBadge(rating) {
    if (rating >= 2000) return '💎 Platinum';
    if (rating >= 1500) return '🥇 Gold';
    if (rating >= 1200) return '🥈 Silver';
    return '🥉 Bronze';
}

function updateAuthStatus() {
    const statusEl = document.getElementById('auth-status');
    const authBtn = document.getElementById('btn-show-auth');
    if (currentUser) {
        statusEl.innerText = `Logged in as ${currentUser} | Rating: ${currentRating} | Rank: ${getRankBadge(currentRating)}`;
        authBtn.innerText = 'Logout';
    } else {
        statusEl.innerText = '';
        authBtn.innerText = 'Login / Register';
        document.getElementById('playerName').disabled = false;
    }
}

document.getElementById('btn-show-auth').addEventListener('click', () => {
    if (currentUser) {
        localStorage.removeItem('auth_token');
        currentUser = null;
        updateAuthStatus();
    } else {
        document.getElementById('auth-modal').style.display = 'flex';
        document.getElementById('auth-error').innerText = '';
    }
});

document.getElementById('btn-close-auth').addEventListener('click', () => {
    document.getElementById('auth-modal').style.display = 'none';
});

async function handleAuth(isLogin) {
    const username = document.getElementById('auth-username').value;
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');
    if (!username || !password) {
        errorEl.innerText = 'Please enter username and password';
        return;
    }
    const endpoint = isLogin ? '/api/login' : '/api/register';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            localStorage.setItem('auth_token', data.token);
            currentUser = data.username;
            currentRating = data.rating;
            document.getElementById('playerName').value = currentUser;
            document.getElementById('playerName').disabled = true;
            document.getElementById('auth-modal').style.display = 'none';
            updateAuthStatus();
        } else {
            errorEl.innerText = data.error;
        }
    } catch (e) {
        errorEl.innerText = 'Network error';
    }
}

document.getElementById('btn-login').addEventListener('click', () => handleAuth(true));
document.getElementById('btn-register').addEventListener('click', () => handleAuth(false));

document.getElementById('btn-show-leaderboard').addEventListener('click', async () => {
    const listEl = document.getElementById('leaderboard-list');
    listEl.innerHTML = '<li>Loading...</li>';
    document.getElementById('leaderboard-modal').style.display = 'flex';
    try {
        const res = await fetch('/api/leaderboard');
        const users = await res.json();
        listEl.innerHTML = '';
        users.forEach((u, i) => {
            const li = document.createElement('li');
            li.style.padding = '8px';
            li.style.borderBottom = '1px solid #444';
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            li.innerHTML = `<span><strong>#${i+1}</strong> ${u.username}</span> <span>${u.rating} ${getRankBadge(u.rating)}</span>`;
            listEl.appendChild(li);
        });
    } catch (e) {
        listEl.innerHTML = '<li>Error loading leaderboard</li>';
    }
});

document.getElementById('btn-close-leaderboard').addEventListener('click', () => {
    document.getElementById('leaderboard-modal').style.display = 'none';
});

// Run auth check on load
checkAuth();
// ----------------------------

const btnOptions = document.getElementById('btn-options');
const optionsModal = document.getElementById('options-modal');
const btnCloseOptions = document.getElementById('btn-close-options');
const btnExitRoom = document.getElementById('btn-exit-room');
const bgmVolumeSlider = document.getElementById('bgm-volume');
const seVolumeSlider = document.getElementById('se-volume');

bgmVolumeSlider.value = bgmController.volume;
seVolumeSlider.value = seVolume;

btnOptions.addEventListener('click', () => {
    optionsModal.style.display = 'flex';
});
btnCloseOptions.addEventListener('click', () => {
    optionsModal.style.display = 'none';
});
btnExitRoom.addEventListener('click', () => {
    optionsModal.style.display = 'none';
    socket.emit('return_lobby');
    window.location.reload();
});
bgmVolumeSlider.addEventListener('input', (e) => {
    bgmController.updateVolume(parseFloat(e.target.value));
});
seVolumeSlider.addEventListener('input', (e) => {
    seVolume = parseFloat(e.target.value);
    localStorage.setItem('seVolume', seVolume);
});

function playSound(type) {
    if (isMuted || seVolume === 0) return;
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    const masterGain = audioCtx.createGain();
    masterGain.gain.value = seVolume;
    
    osc.connect(gainNode);
    gainNode.connect(masterGain);
    masterGain.connect(audioCtx.destination);
    
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
let targetPaddle = { x: 0, y: 0, updated: false }; // ネットワーク送信用の最新座標

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
    bgmController.initWebAudio();
    if (!bgmController.hasStarted) {
        bgmController.hasStarted = true;
        bgmController.play('WAITING');
    }
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
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (roomId) {
        joinGame(roomId);
    } else {
        alert("Please enter a Room ID to create");
    }
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

document.querySelectorAll('.size-option').forEach(el => {
    el.addEventListener('click', () => {
        const size = parseInt(el.getAttribute('data-size'), 10);
        socket.emit('change_size', size);
    });
});

document.querySelectorAll('.skin-option').forEach(el => {
    el.addEventListener('click', () => {
        const skin = el.getAttribute('data-skin');
        socket.emit('change_skin', skin);
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
    if (bgmController.currentTheme && bgmController.audioElements[bgmController.currentTheme]) {
        bgmController.audioElements[bgmController.currentTheme].pause();
    }
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
    
    if (state.boardSize && state.boardSize !== BOARD_SIZE) {
        BOARD_SIZE = state.boardSize;
        GOAL_SIZE = Math.floor(BOARD_SIZE * 0.3);
        canvas.width = BOARD_SIZE;
        canvas.height = BOARD_SIZE;
    }
    
    if (state.status === 'WAITING') {
        document.getElementById('gameover-overlay').style.display = 'none';
        document.getElementById('game-container').style.display = 'none';
        
        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen) lobbyScreen.style.display = 'block';
        
        bgmController.play('WAITING');
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
        
        if (state.boardSize) {
            document.querySelectorAll('.size-option').forEach(el => {
                if (parseInt(el.getAttribute('data-size'), 10) === state.boardSize) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });
        }
        
        if (myRole && state.players[myRole]) {
            const mySkin = state.players[myRole].skin || 'DEFAULT';
            document.querySelectorAll('.skin-option').forEach(el => {
                if (el.getAttribute('data-skin') === mySkin) {
                    el.classList.add('selected');
                } else {
                    el.classList.remove('selected');
                }
            });
        }
        document.getElementById('gameover-overlay').style.display = 'none';
    } else if (state.status === 'PLAYING') {
        bgmController.play(state.stage || 'CHAOS_VOID');
        document.getElementById('gameover-overlay').style.display = 'none';
        const lobbyScreen = document.getElementById('lobby-screen');
        if (lobbyScreen && lobbyScreen.style.display === 'block') {
            lobbyScreen.style.display = 'none';
            document.getElementById('game-container').style.display = 'block';
        }
        if (!isGameLoopRunning) {
            isGameLoopRunning = true;
            gameLoop();
        }
    } else if (state.status === 'GAMEOVER') {
        const overlay = document.getElementById('gameover-overlay');
        overlay.style.display = 'flex';
        document.getElementById('gameover-title').innerText = `WINNER: ${state.winner || 'NONE'}`;
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
    
    targetPaddle.x = boundedX;
    targetPaddle.y = boundedY;
    targetPaddle.updated = true;
}

canvas.addEventListener('mousemove', (e) => handleInput(e.clientX, e.clientY));
canvas.addEventListener('touchmove', (e) => {
    e.preventDefault(); 
    handleInput(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });

function drawBoard() {
    const stage = (serverState && serverState.stage) ? serverState.stage : 'CHAOS_VOID';
    
    // 背景画像の描画
    if (bgImages[stage] && bgImages[stage].complete) {
        ctx.drawImage(bgImages[stage], 0, 0, BOARD_SIZE, BOARD_SIZE);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);
    } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);
    }

    const pulse = (Math.sin(Date.now() / 400) + 1) / 2; // 0.0 to 1.0

    let centerLineColor = 'rgba(255, 255, 255, 0.2)';
    let defaultWallColor = '#fff';
    let shadowColor = '#ffffff';
    let baseShadowBlur = 5;
    
    if (stage === 'CHAOS_VOID') {
        centerLineColor = `rgba(255, 0, 60, ${0.3 + pulse * 0.4})`;
        defaultWallColor = '#ff003c';
        shadowColor = '#8b0000';
        baseShadowBlur = 10 + pulse * 10;
    } else if (stage === 'BLOOD_MOON') {
        centerLineColor = `rgba(150, 0, 255, ${0.3 + pulse * 0.4})`;
        defaultWallColor = '#aa00ff';
        shadowColor = '#5500aa';
        baseShadowBlur = 8 + pulse * 8;
    } else if (stage === 'ABYSSAL_ICE') {
        centerLineColor = `rgba(0, 255, 255, ${0.3 + pulse * 0.4})`;
        defaultWallColor = '#00ffff';
        shadowColor = '#0088ff';
        baseShadowBlur = 12 + pulse * 5;
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
        ctx.lineWidth = isGoal ? 10 : 4;
        
        ctx.shadowBlur = isGoal ? baseShadowBlur * 1.5 : baseShadowBlur;
        ctx.shadowColor = isGoal ? color : shadowColor;
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.shadowBlur = 0;
    };

    drawWall(0, 0, goalStart, 0, defaultWallColor);
    drawWall(goalStart, 0, goalEnd, 0, getGoalColor('top', '#ff4444'), true);
    drawWall(goalEnd, 0, BOARD_SIZE, 0, defaultWallColor);

    drawWall(0, BOARD_SIZE, goalStart, BOARD_SIZE, defaultWallColor);
    drawWall(goalStart, BOARD_SIZE, goalEnd, BOARD_SIZE, getGoalColor('bottom', '#ff4444'), true);
    drawWall(goalEnd, BOARD_SIZE, BOARD_SIZE, BOARD_SIZE, defaultWallColor);

    drawWall(0, 0, 0, goalStart, defaultWallColor);
    drawWall(0, goalStart, 0, goalEnd, getGoalColor('left', '#ff4444'), true);
    drawWall(0, goalEnd, 0, BOARD_SIZE, defaultWallColor);

    drawWall(BOARD_SIZE, 0, BOARD_SIZE, goalStart, defaultWallColor);
    drawWall(BOARD_SIZE, goalStart, BOARD_SIZE, goalEnd, getGoalColor('right', '#ff4444'), true);
    drawWall(BOARD_SIZE, goalEnd, BOARD_SIZE, BOARD_SIZE, defaultWallColor);

    ctx.strokeStyle = centerLineColor;
    ctx.lineWidth = 3;
    ctx.shadowBlur = baseShadowBlur;
    ctx.shadowColor = shadowColor;
    ctx.beginPath();
    ctx.moveTo(0, BOARD_SIZE / 2);
    ctx.lineTo(BOARD_SIZE, BOARD_SIZE / 2);
    ctx.moveTo(BOARD_SIZE / 2, 0);
    ctx.lineTo(BOARD_SIZE / 2, BOARD_SIZE);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(BOARD_SIZE / 2, BOARD_SIZE / 2, 100, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.shadowBlur = 0;
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

function drawPaddle(x, y, color, isMe, radius, sp = 0, skin = 'DEFAULT') {
    // 暗黒オーラ
    ctx.beginPath();
    ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 20;
    ctx.shadowColor = '#000000';
    ctx.fill();
    ctx.shadowBlur = 0;

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

    if (skin && skin !== 'DEFAULT' && skinImages[skin] && skinImages[skin].complete) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(skinImages[skin], x - radius, y - radius, radius * 2, radius * 2);
        ctx.restore();
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
    } else {
        drawCircle(x, y, radius, color, isMe);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.4, 0, Math.PI * 2);
        ctx.fill();
    }
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

    const time = Date.now() / 200;
    const scale = 1 + Math.sin(time) * 0.1;
    const currentRadius = ITEM_RADIUS * scale;

    ctx.save();
    ctx.translate(x, y);

    // Rotating outer ring
    ctx.rotate(time * 0.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6, 2, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, currentRadius + 8, 0, Math.PI * 2);
    ctx.shadowBlur = 10;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.setLineDash([]);

    // Reverse rotating inner hexagon
    ctx.rotate(-time * 1.2);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI * 2) / 6;
        const hx = Math.cos(angle) * (currentRadius + 3);
        const hy = Math.sin(angle) * (currentRadius + 3);
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    // Draw Item Image with circular clip
    ctx.beginPath();
    ctx.arc(0, 0, currentRadius, 0, Math.PI * 2);
    ctx.clip();

    if (itemImages[type] && itemImages[type].complete) {
        ctx.drawImage(itemImages[type], -currentRadius, -currentRadius, currentRadius * 2, currentRadius * 2);
    } else {
        ctx.fillStyle = color;
        ctx.fill();
    }
    
    // glowing border
    ctx.shadowBlur = 15;
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, currentRadius, 0, Math.PI * 2);
    ctx.stroke();
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
    }
}

function gameLoop() {
    // Canvasが表示されていない時は描画処理をスキップ
    if (gameContainer.style.display !== 'block') {
        requestAnimationFrame(gameLoop);
        return;
    }

    if (targetPaddle.updated && myRole && serverState && serverState.status === 'PLAYING' && !serverState.players[myRole].eliminated) {
        socket.emit('player_input', { x: targetPaddle.x, y: targetPaddle.y });
        targetPaddle.updated = false;
    }

    if (bgmController.analyserNode && serverState && serverState.status === 'PLAYING') {
        bgmController.analyserNode.getByteFrequencyData(bgmController.freqData);
        let sum = 0;
        for (let i = 0; i < 10; i++) {
            sum += bgmController.freqData[i];
        }
        const avg = sum / 10; // 0 to 255
        const rotArms = (avg / 255) * 120; // 0 to 120 deg
        const rotLegs = (avg / 255) * 60; // 0 to 60 deg
        const bounce = (avg / 255) * -50; // bounce up by 50px
        
        const memeL = document.getElementById('dancing-meme-left');
        const memeR = document.getElementById('dancing-meme-right');
        
        [memeL, memeR].forEach(container => {
            if (!container) return;
            container.style.display = 'block';
            container.style.transform = `translateY(calc(-50% + ${bounce}px))`;
            const armL = container.querySelector('.meme-arm-left');
            const armR = container.querySelector('.meme-arm-right');
            const legL = container.querySelector('.meme-leg-left');
            const legR = container.querySelector('.meme-leg-right');
            if(armL) armL.style.transform = `rotate(${rotArms}deg)`;
            if(armR) armR.style.transform = `rotate(-${rotArms}deg)`;
            if(legL) legL.style.transform = `rotate(${rotLegs}deg)`;
            if(legR) legR.style.transform = `rotate(-${rotLegs}deg)`;
        });
    } else {
        const memeL = document.getElementById('dancing-meme-left');
        const memeR = document.getElementById('dancing-meme-right');
        if (memeL) memeL.style.display = 'none';
        if (memeR) memeR.style.display = 'none';
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
                    drawPaddle(localPaddle.x, localPaddle.y, p.color, true, p.paddleRadius, p.sp, p.skin);
                } else {
                    drawPaddle(p.x, p.y, p.color, false, p.paddleRadius, p.sp, p.skin);
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

document.getElementById('btn-restart').addEventListener('click', () => {
    socket.emit('restart_game');
});

document.getElementById('btn-return-lobby').addEventListener('click', () => {
    socket.emit('return_lobby');
    window.location.reload();
});

gameLoop();
