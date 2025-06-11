// Agora Client Configuration
let agoraClient = null;
let localAudioTrack = null;
let remoteAudioTrack = null;
let currentPageType = null;
let isCallActive = false;
let isMuted = false;
let callStartTime = null;

// Configuration
const AGORA_CONFIG = {
    appId: '', // Will be set from environment variable
    channel: 'cucina-pizzeria-channel',
    token: null, // For development, using null token
    websocketUrl: 'msync-api-71.chat.agora.io',
    restApiUrl: 'a71.chat.agora.io'
};

// Initialize Agora client
async function initializeAgoraClient(pageType) {
    currentPageType = pageType;

    // Get Agora App ID from environment variable or use default
    AGORA_CONFIG.appId = getAgoraAppId();

    if (!AGORA_CONFIG.appId || AGORA_CONFIG.appId === 'not-configured') {
        showError('Agora App ID not configured. Please check your Agora project settings.');
        return;
    }

    try {
        // Create Agora client
        agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

        // Set up event listeners
        setupAgoraEventListeners();

        // Update UI
        updateConnectionStatus('disconnected', 'Ready to connect');

        // Listen for incoming calls
        listenForIncomingCalls();

        console.log(`${pageType} client initialized successfully`);
        console.log('Using App ID:', AGORA_CONFIG.appId);

        // Show configuration warning
        if (AGORA_CONFIG.appId.includes('ccdaa7')) {
            console.warn('⚠️ This App ID may require token authentication. If calls fail, please configure your Agora project for testing mode or provide a token server.');
        }

    } catch (error) {
        console.error('Failed to initialize Agora client:', error);
        showError('Failed to initialize voice calling system: ' + error.message);
    }
}

// Get Agora App ID from environment or use fallback
function getAgoraAppId() {
    // Use the App ID from environment variable
    return window.AGORA_APP_ID || process.env.AGORA_APP_ID || 'your-agora-app-id-here';
}

// Apply Agora configuration
function applyAgoraConfig(config) {
    if (config.websocketUrl) {
        AgoraRTC.setLogLevel(4); // Enable debug logs
        console.log('Configuring Agora with:', config);
    }
}

// Set up Agora event listeners
function setupAgoraEventListeners() {
    // User joined
    agoraClient.on("user-joined", async (user) => {
        console.log('User joined:', user.uid);
        updateCallStatus('User connected');
    });

    // User left
    agoraClient.on("user-left", (user) => {
        console.log('User left:', user.uid);
        handleUserLeft();
    });

    // User published audio
    agoraClient.on("user-published", async (user, mediaType) => {
        if (mediaType === "audio") {
            console.log('User published audio:', user.uid);
            await agoraClient.subscribe(user, mediaType);
            remoteAudioTrack = user.audioTrack;
            remoteAudioTrack.play();
            updateCallStatus('Call active - Audio connected');
        }
    });

    // User unpublished
    agoraClient.on("user-unpublished", (user, mediaType) => {
        if (mediaType === "audio") {
            console.log('User unpublished audio:', user.uid);
            if (remoteAudioTrack) {
                remoteAudioTrack.stop();
                remoteAudioTrack = null;
            }
        }
    });

    // Connection state changed
    agoraClient.on("connection-state-change", (curState, revState) => {
        console.log('Connection state changed:', curState);
        handleConnectionStateChange(curState);
    });

    // Exception occurred
    agoraClient.on("exception", (event) => {
        console.error('Agora exception:', event);
        showError('Connection error: ' + event.msg);
    });
}

// Handle connection state changes
function handleConnectionStateChange(state) {
    switch (state) {
        case 'CONNECTED':
            updateConnectionStatus('connected', 'Connected to voice server');
            break;
        case 'CONNECTING':
            updateConnectionStatus('connecting', 'Connecting...');
            break;
        case 'DISCONNECTED':
            updateConnectionStatus('disconnected', 'Disconnected');
            if (isCallActive) {
                endCall();
            }
            break;
        case 'RECONNECTING':
            updateConnectionStatus('connecting', 'Reconnecting...');
            break;
        case 'FAILED':
            updateConnectionStatus('disconnected', 'Connection failed');
            showError('Failed to connect to voice server');
            break;
    }
}

// Initiate a call
async function initiateCall() {
    if (isCallActive) {
        console.log('Call already active, ignoring');
        return;
    }

    console.log('Starting call initiation...');
    console.log('Agora App ID:', getAgoraAppId());

    try {
        updateCallStatus('Initiating call...');

        // Join the channel
        console.log('Joining channel...');
        await joinChannel();
        console.log('Channel joined successfully');

        // Create and publish local audio track
        console.log('Creating audio track...');
        await createAndPublishAudio();
        console.log('Audio track created and published');

        // Signal the other page about incoming call
        console.log('Signaling incoming call...');
        signalIncomingCall();

        isCallActive = true;
        callStartTime = new Date();
        updateCallButtons(true);
        updateCallStatus('Calling...');

        logCall('outgoing', 'Call initiated');
        console.log('Call initiated successfully');

    } catch (error) {
        console.error('Failed to initiate call:', error);
        console.error('Error details:', error.stack);
        showError('Failed to start call: ' + error.message);
        updateCallStatus('Call failed');
        updateCallButtons(false);
    }
}

// Join Agora channel
async function joinChannel() {
    const uid = currentPageType === 'cucina' ? 1 : 2;
    console.log('Attempting to join channel with:', {
        appId: AGORA_CONFIG.appId,
        channel: AGORA_CONFIG.channel,
        uid: uid
    });

    await agoraClient.join(AGORA_CONFIG.appId, AGORA_CONFIG.channel, AGORA_CONFIG.token, uid);
    console.log('Joined channel successfully with UID:', uid);
}

// Create and publish local audio track
async function createAndPublishAudio() {
    try {
        console.log('Requesting microphone access...');
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        console.log('Microphone track created successfully');

        console.log('Publishing audio track...');
        await agoraClient.publish([localAudioTrack]);
        console.log('Local audio track published successfully');
    } catch (error) {
        console.error('Failed to create/publish audio track:', error);
        console.error('Audio error details:', error);
        throw new Error('Microphone access denied or unavailable: ' + error.message);
    }
}

// Signal incoming call to other page
function signalIncomingCall() {
    const callData = {
        from: currentPageType,
        to: currentPageType === 'cucina' ? 'pizzeria' : 'cucina',
        timestamp: Date.now(),
        action: 'incoming-call'
    };

    localStorage.setItem('call-signal', JSON.stringify(callData));
}

// Listen for incoming calls
function listenForIncomingCalls() {
    // Listen for localStorage changes (simple signaling)
    window.addEventListener('storage', (event) => {
        if (event.key === 'call-signal') {
            const callData = JSON.parse(event.newValue);
            if (callData && callData.to === currentPageType && callData.action === 'incoming-call') {
                showIncomingCall();
            }
        }
    });

    // Also check on page focus (for same-origin pages)
    window.addEventListener('focus', () => {
        checkForIncomingCall();
    });

    // Check periodically
    setInterval(checkForIncomingCall, 1000);
}

// Check for incoming call
function checkForIncomingCall() {
    const callSignal = localStorage.getItem('call-signal');
    if (callSignal) {
        const callData = JSON.parse(callSignal);
        if (callData.to === currentPageType && callData.action === 'incoming-call') {
            const timeDiff = Date.now() - callData.timestamp;
            if (timeDiff < 30000 && !isCallActive) { // Call valid for 30 seconds
                showIncomingCall();
            }
        }
    }
}

// Show incoming call UI
function showIncomingCall() {
    if (isCallActive) {
        return; // Already in a call
    }

    const incomingCallElement = document.getElementById('incomingCall');
    incomingCallElement.style.display = 'flex';

    // Play ringtone (if audio context allows)
    playRingtone();
}

// Accept incoming call
async function acceptCall() {
    try {
        hideIncomingCall();
        updateCallStatus('Accepting call...');

        // Join the channel
        await joinChannel();

        // Create and publish local audio track
        await createAndPublishAudio();

        isCallActive = true;
        callStartTime = new Date();
        updateCallButtons(true);
        updateCallStatus('Call active');

        // Clear the call signal
        localStorage.removeItem('call-signal');

        logCall('incoming', 'Call accepted');

    } catch (error) {
        console.error('Failed to accept call:', error);
        showError('Failed to accept call: ' + error.message);
        hideIncomingCall();
    }
}

// Decline incoming call
function declineCall() {
    hideIncomingCall();
    localStorage.removeItem('call-signal');
    logCall('missed', 'Call declined');
}

// Hide incoming call UI
function hideIncomingCall() {
    const incomingCallElement = document.getElementById('incomingCall');
    incomingCallElement.style.display = 'none';
    stopRingtone();
}

// End call
async function endCall() {
    try {
        updateCallStatus('Ending call...');

        // Leave the channel
        if (agoraClient) {
            await agoraClient.leave();
        }

        // Stop and close local audio track
        if (localAudioTrack) {
            localAudioTrack.stop();
            localAudioTrack.close();
            localAudioTrack = null;
        }

        // Stop remote audio track
        if (remoteAudioTrack) {
            remoteAudioTrack.stop();
            remoteAudioTrack = null;
        }

        isCallActive = false;
        isMuted = false;
        updateCallButtons(false);
        updateCallStatus('Call ended');

        // Clear call signal
        localStorage.removeItem('call-signal');

        // Log call duration
        if (callStartTime) {
            const duration = Math.floor((Date.now() - callStartTime) / 1000);
            logCall('completed', `Call duration: ${formatDuration(duration)}`);
            callStartTime = null;
        }

        setTimeout(() => {
            updateCallStatus('Ready to call');
        }, 2000);

    } catch (error) {
        console.error('Error ending call:', error);
        showError('Error ending call: ' + error.message);
    }
}

// Handle user left
function handleUserLeft() {
    if (isCallActive) {
        updateCallStatus('Other party disconnected');
        setTimeout(() => {
            endCall();
        }, 2000);
    }
}

// Toggle mute
async function toggleMute() {
    if (!localAudioTrack || !isCallActive) {
        return;
    }

    try {
        if (isMuted) {
            await localAudioTrack.setEnabled(true);
            isMuted = false;
            updateMuteButton(false);
            updateCallStatus('Microphone unmuted');
        } else {
            await localAudioTrack.setEnabled(false);
            isMuted = true;
            updateMuteButton(true);
            updateCallStatus('Microphone muted');
        }

        setTimeout(() => {
            if (isCallActive) {
                updateCallStatus('Call active');
            }
        }, 2000);

    } catch (error) {
        console.error('Failed to toggle mute:', error);
        showError('Failed to toggle mute: ' + error.message);
    }
}

// Adjust volume
function adjustVolume(value) {
    if (remoteAudioTrack) {
        remoteAudioTrack.setVolume(value / 100);
    }
    document.getElementById('volumeValue').textContent = value + '%';
}

// UI Update Functions
function updateConnectionStatus(status, text) {
    const statusElement = document.getElementById('connectionStatus');
    const statusText = document.getElementById('statusText');

    statusElement.className = 'status-indicator ' + status;
    statusText.textContent = text;
}

function updateCallStatus(status) {
    document.getElementById('callStatus').textContent = status;
}

function updateCallButtons(inCall) {
    const callButton = document.getElementById('callButton');
    const hangupButton = document.getElementById('hangupButton');
    const muteButton = document.getElementById('muteButton');

    callButton.disabled = inCall;
    hangupButton.disabled = !inCall;
    muteButton.disabled = !inCall;

    if (!inCall) {
        updateMuteButton(false);
    }
}

function updateMuteButton(muted) {
    const muteButton = document.getElementById('muteButton');
    if (muted) {
        muteButton.classList.add('muted');
        muteButton.innerHTML = '<i class="fas fa-microphone-slash"></i> Unmute';
    } else {
        muteButton.classList.remove('muted');
        muteButton.innerHTML = '<i class="fas fa-microphone"></i> Mute';
    }
}

// Utility Functions
function showError(message) {
    console.error(message);
    alert('Error: ' + message);
}

function logCall(type, details) {
    const callLogs = document.getElementById('callLogs');
    const noLogs = callLogs.querySelector('.no-logs');

    if (noLogs) {
        noLogs.remove();
    }

    const logEntry = document.createElement('div');
    logEntry.className = 'call-log-entry';

    const now = new Date();
    const timeString = now.toLocaleTimeString();

    logEntry.innerHTML = `
        <div>
            <span class="call-log-status ${type}">${details}</span>
        </div>
        <div class="call-log-time">${timeString}</div>
    `;

    callLogs.insertBefore(logEntry, callLogs.firstChild);

    // Keep only last 10 entries
    const entries = callLogs.querySelectorAll('.call-log-entry');
    if (entries.length > 10) {
        for (let i = 10; i < entries.length; i++) {
            entries[i].remove();
        }
    }
}

function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Simple ringtone simulation
let ringtoneInterval = null;

function playRingtone() {
    // Simple beep simulation using Web Audio API
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();

        ringtoneInterval = setInterval(() => {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.5);
        }, 1000);
    } catch (error) {
        console.log('Ringtone not available:', error);
    }
}

function stopRingtone() {
    if (ringtoneInterval) {
        clearInterval(ringtoneInterval);
        ringtoneInterval = null;
    }
}

// Global functions for HTML onclick handlers
window.initiateCall = initiateCall;
window.endCall = endCall;
window.toggleMute = toggleMute;
window.adjustVolume = adjustVolume;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.initializeAgoraClient = initializeAgoraClient;
