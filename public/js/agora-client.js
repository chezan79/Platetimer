
// Agora Voice Call Client
let agoraClient = null;
let localAudioTrack = null;
let remoteUsers = {};
let isCallActive = false;
let isMuted = false;

// Configurazione Agora
const AGORA_CONFIG = {
    appId: window.AGORA_APP_ID || "your-agora-app-id",
    channel: "restaurant-voice-call",
    token: null // Per testing, usa null. In produzione, genera token dal server
};

async function initializeAgoraClient(pageType) {
    try {
        console.log('🎤 Inizializzazione client Agora per:', pageType);
        
        // Crea client Agora
        agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        
        // Event listeners
        agoraClient.on("user-published", handleUserPublished);
        agoraClient.on("user-unpublished", handleUserUnpublished);
        agoraClient.on("user-left", handleUserLeft);
        
        // Aggiorna status
        updateConnectionStatus('connected');
        
        console.log('✅ Client Agora inizializzato');
        return true;
        
    } catch (error) {
        console.error('❌ Errore inizializzazione Agora:', error);
        updateConnectionStatus('error');
        return false;
    }
}

async function initiateAgoraCall() {
    try {
        if (!agoraClient) {
            throw new Error('Client Agora non inizializzato');
        }
        
        console.log('📞 Avvio chiamata Agora...');
        updateCallStatus('Connecting...');
        
        // Join del canale
        await agoraClient.join(AGORA_CONFIG.appId, AGORA_CONFIG.channel, AGORA_CONFIG.token, null);
        
        // Crea track audio locale
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        
        // Pubblica il track audio
        await agoraClient.publish([localAudioTrack]);
        
        isCallActive = true;
        updateCallStatus('Call active');
        
        // Aggiorna UI
        document.getElementById('callButton').disabled = true;
        document.getElementById('hangupButton').disabled = false;
        document.getElementById('muteButton').disabled = false;
        
        console.log('✅ Chiamata Agora avviata');
        
    } catch (error) {
        console.error('❌ Errore chiamata Agora:', error);
        updateCallStatus('Call failed');
        await endAgoraCall();
    }
}

async function endAgoraCall() {
    try {
        console.log('📞 Terminazione chiamata Agora...');
        
        // Ferma track locale
        if (localAudioTrack) {
            localAudioTrack.stop();
            localAudioTrack.close();
            localAudioTrack = null;
        }
        
        // Lascia il canale
        if (agoraClient) {
            await agoraClient.leave();
        }
        
        isCallActive = false;
        isMuted = false;
        remoteUsers = {};
        
        // Aggiorna UI
        updateCallStatus('Call ended');
        document.getElementById('callButton').disabled = false;
        document.getElementById('hangupButton').disabled = true;
        document.getElementById('muteButton').disabled = true;
        document.getElementById('muteButton').innerHTML = '<i class="fas fa-microphone"></i> Mute';
        
        console.log('✅ Chiamata Agora terminata');
        
    } catch (error) {
        console.error('❌ Errore terminazione Agora:', error);
    }
}

async function toggleAgoraMute() {
    try {
        if (!localAudioTrack || !isCallActive) return;
        
        if (isMuted) {
            await localAudioTrack.setEnabled(true);
            isMuted = false;
            document.getElementById('muteButton').innerHTML = '<i class="fas fa-microphone"></i> Mute';
            console.log('🎤 Microfono riattivato');
        } else {
            await localAudioTrack.setEnabled(false);
            isMuted = true;
            document.getElementById('muteButton').innerHTML = '<i class="fas fa-microphone-slash"></i> Unmute';
            console.log('🔇 Microfono mutato');
        }
        
    } catch (error) {
        console.error('❌ Errore toggle mute:', error);
    }
}

async function handleUserPublished(user, mediaType) {
    console.log('👥 Utente pubblicato:', user.uid, mediaType);
    
    if (mediaType === 'audio') {
        // Subscribe al track audio dell'utente
        await agoraClient.subscribe(user, mediaType);
        
        // Play del track audio
        user.audioTrack.play();
        
        remoteUsers[user.uid] = user;
        updateCallStatus(`Connected to ${user.uid}`);
        
        console.log('🔊 Audio remoto avviato');
    }
}

function handleUserUnpublished(user, mediaType) {
    console.log('👥 Utente non pubblicato:', user.uid, mediaType);
    
    if (mediaType === 'audio') {
        delete remoteUsers[user.uid];
        
        if (Object.keys(remoteUsers).length === 0) {
            updateCallStatus('Call active - waiting for others');
        }
    }
}

function handleUserLeft(user) {
    console.log('👋 Utente uscito:', user.uid);
    delete remoteUsers[user.uid];
    
    if (Object.keys(remoteUsers).length === 0) {
        updateCallStatus('Call active - waiting for others');
    }
}

function updateConnectionStatus(status) {
    const statusElement = document.getElementById('statusText');
    const indicator = document.querySelector('#connectionStatus i');
    
    if (!statusElement || !indicator) return;
    
    switch (status) {
        case 'connected':
            statusElement.textContent = 'Connected';
            indicator.style.color = '#28a745';
            break;
        case 'connecting':
            statusElement.textContent = 'Connecting...';
            indicator.style.color = '#ffc107';
            break;
        case 'disconnected':
            statusElement.textContent = 'Disconnected';
            indicator.style.color = '#dc3545';
            break;
        case 'error':
            statusElement.textContent = 'Error';
            indicator.style.color = '#dc3545';
            break;
    }
}

function updateCallStatus(status) {
    const callStatusElement = document.getElementById('callStatus');
    if (callStatusElement) {
        callStatusElement.textContent = status;
    }
}

function adjustVolume(value) {
    // Aggiorna display volume
    const volumeValue = document.getElementById('volumeValue');
    if (volumeValue) {
        volumeValue.textContent = `${value}%`;
    }
    
    // Applica volume a tutti i track audio remoti
    Object.values(remoteUsers).forEach(user => {
        if (user.audioTrack) {
            user.audioTrack.setVolume(parseInt(value));
        }
    });
    
    console.log('🔊 Volume impostato a:', value + '%');
}

// Funzioni globali per compatibilità
window.initiateAgoraCall = initiateAgoraCall;
window.endAgoraCall = endAgoraCall;
window.toggleAgoraMute = toggleAgoraMute;
window.adjustVolume = adjustVolume;
window.initializeAgoraClient = initializeAgoraClient;
