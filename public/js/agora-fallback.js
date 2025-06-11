// Fallback voice communication using WebRTC peer-to-peer
let localConnection = null;
let remoteConnection = null;
let localStream = null;
let dataChannel = null;

// WebRTC configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Fallback voice call system
class FallbackVoiceCall {
    constructor() {
        this.isActive = false;
        this.isMuted = false;
        this.currentPageType = null;
    }

    async initialize(pageType) {
        this.currentPageType = pageType;
        console.log('Initializing fallback voice system for:', pageType);

        // Listen for signaling messages
        this.listenForSignaling();

        updateConnectionStatus('disconnected', 'Fallback system ready');
        return true;
    }

    async startCall() {
        if (this.isActive) {
            console.log('Call already active');
            return;
        }

        console.log('Starting fallback call...');
        updateCallStatus('Initiating call...');

        try {
            // Get user media
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('Got local audio stream');

            // Create peer connection
            localConnection = new RTCPeerConnection(rtcConfig);

            // Add local stream
            localStream.getTracks().forEach(track => {
                localConnection.addTrack(track, localStream);
            });

            // Create data channel for signaling
            dataChannel = localConnection.createDataChannel('signaling');

            // Set up event handlers
            this.setupConnectionHandlers(localConnection, true);

            // Create offer
            const offer = await localConnection.createOffer();
            await localConnection.setLocalDescription(offer);

            // Send offer through localStorage signaling
            this.sendSignal({
                type: 'offer',
                offer: offer,
                from: this.currentPageType,
                timestamp: Date.now()
            });

            this.isActive = true;
            updateCallButtons(true);
            updateCallStatus('Calling...');
            logCall('outgoing', 'Fallback call initiated');

        } catch (error) {
            console.error('Failed to start fallback call:', error);
            updateCallStatus('Call failed');
            showError('Failed to access microphone: ' + error.message);
        }
    }

    async acceptCall(offer) {
        console.log('Accepting fallback call...');

        try {
            // Get user media
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Create peer connection
            remoteConnection = new RTCPeerConnection(rtcConfig);

            // Add local stream
            localStream.getTracks().forEach(track => {
                remoteConnection.addTrack(track, localStream);
            });

            // Set up event handlers
            this.setupConnectionHandlers(remoteConnection, false);

            // Set remote description
            await remoteConnection.setRemoteDescription(offer);

            // Create answer
            const answer = await remoteConnection.createAnswer();
            await remoteConnection.setLocalDescription(answer);

            // Send answer
            this.sendSignal({
                type: 'answer',
                answer: answer,
                from: this.currentPageType,
                timestamp: Date.now()
            });

            this.isActive = true;
            updateCallButtons(true);
            updateCallStatus('Call active');
            logCall('incoming', 'Fallback call accepted');

        } catch (error) {
            console.error('Failed to accept call:', error);
            showError('Failed to accept call: ' + error.message);
        }
    }

    setupConnectionHandlers(connection, isInitiator) {
        connection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    from: this.currentPageType,
                    timestamp: Date.now()
                });
            }
        };

        connection.ontrack = (event) => {
            console.log('Received remote audio track');
            const audio = new Audio();
            audio.srcObject = event.streams[0];
            audio.play();
            updateCallStatus('Call active - Audio connected');
        };

        connection.onconnectionstatechange = () => {
            console.log('Connection state:', connection.connectionState);
            if (connection.connectionState === 'connected') {
                updateConnectionStatus('connected', 'Voice connected');
            } else if (connection.connectionState === 'disconnected') {
                this.endCall();
            }
        };
    }

    sendSignal(data) {
        const targetPage = this.currentPageType === 'cucina' ? 'pizzeria' : 'cucina';
        const signalKey = `webrtc-signal-${targetPage}`;
        localStorage.setItem(signalKey, JSON.stringify(data));

        // Also trigger storage event for same-origin pages
        window.dispatchEvent(new StorageEvent('storage', {
            key: signalKey,
            newValue: JSON.stringify(data)
        }));
    }

    listenForSignaling() {
        const signalKey = `webrtc-signal-${this.currentPageType}`;

        // Listen for localStorage changes
        window.addEventListener('storage', async (event) => {
            if (event.key === signalKey && event.newValue) {
                const signal = JSON.parse(event.newValue);
                await this.handleSignal(signal);
                // Clear the signal
                localStorage.removeItem(signalKey);
            }
        });

        // Check periodically for signals
        setInterval(() => {
            const signalData = localStorage.getItem(signalKey);
            if (signalData) {
                const signal = JSON.parse(signalData);
                if (Date.now() - signal.timestamp < 30000) { // 30 second timeout
                    this.handleSignal(signal);
                }
                localStorage.removeItem(signalKey);
            }
        }, 1000);
    }

    async handleSignal(signal) {
        console.log('Received signal:', signal.type);

        try {
            if (signal.type === 'offer' && !this.isActive) {
                // Show incoming call
                this.showIncomingCall(signal);
            } else if (signal.type === 'answer') {
                await localConnection.setRemoteDescription(signal.answer);
            } else if (signal.type === 'ice-candidate') {
                const connection = localConnection || remoteConnection;
                if (connection) {
                    await connection.addIceCandidate(signal.candidate);
                }
            }
        } catch (error) {
            console.error('Error handling signal:', error);
        }
    }

    showIncomingCall(signal) {
        const incomingCallElement = document.getElementById('incomingCall');
        incomingCallElement.style.display = 'flex';

        // Store the offer for accepting
        window.pendingOffer = signal.offer;

        playRingtone();
    }

    async endCall() {
        console.log('Ending fallback call...');

        // Close connections
        if (localConnection) {
            localConnection.close();
            localConnection = null;
        }
        if (remoteConnection) {
            remoteConnection.close();
            remoteConnection = null;
        }

        // Stop local stream
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        this.isActive = false;
        this.isMuted = false;
        updateCallButtons(false);
        updateCallStatus('Call ended');
        updateConnectionStatus('disconnected', 'Fallback system ready');

        setTimeout(() => {
            updateCallStatus('Ready to call');
        }, 2000);
    }

    async toggleMute() {
        if (!localStream || !this.isActive) return;

        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            this.isMuted = !audioTrack.enabled;
            updateMuteButton(this.isMuted);
            updateCallStatus(this.isMuted ? 'Microphone muted' : 'Microphone unmuted');

            setTimeout(() => {
                if (this.isActive) {
                    updateCallStatus('Call active');
                }
            }, 2000);
        }
    }
}

// Create global fallback instance
window.fallbackVoiceCall = new FallbackVoiceCall();

// Override global functions to use fallback
window.fallbackInitiateCall = async function() {
    await window.fallbackVoiceCall.startCall();
};

window.fallbackAcceptCall = async function() {
    hideIncomingCall();
    if (window.pendingOffer) {
        await window.fallbackVoiceCall.acceptCall(window.pendingOffer);
        window.pendingOffer = null;
    }
};

window.fallbackEndCall = async function() {
    await window.fallbackVoiceCall.endCall();
};

window.fallbackToggleMute = async function() {
    await window.fallbackVoiceCall.toggleMute();
};
// Agora Fallback System - WebRTC locale quando Agora non è disponibile
window.fallbackVoiceCall = {
    isInitialized: false,
    currentPageType: null,
    isCallActive: false,
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    currentCallId: null,

    // Configurazione WebRTC
    rtcConfiguration: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    },

    initialize: function(pageType) {
        this.currentPageType = pageType;
        this.isInitialized = true;
        console.log(`📞 Sistema fallback inizializzato per ${pageType}`);

        // Aggiorna l'UI per indicare che stiamo usando il fallback
        this.updateConnectionStatus('connected', 'Using fallback communication');
    },

    initiateCall: async function() {
        if (this.isCallActive) {
            console.log('📞 Chiamata già attiva');
            return;
        }

        try {
            console.log('📞 Avvio chiamata fallback...');
            this.updateCallStatus('Initiating fallback call...');

            // Ottieni accesso al microfono
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('🎤 Accesso microfono ottenuto');

            // Crea connessione peer
            this.peerConnection = new RTCPeerConnection(this.rtcConfiguration);
            this.setupPeerConnectionHandlers();

            // Aggiungi stream locale
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Segnala chiamata in arrivo via WebSocket
            this.currentCallId = Date.now().toString();
            this.signalIncomingCall();

            this.isCallActive = true;
            this.updateCallButtons(true);
            this.updateCallStatus('Calling...');

            console.log('✅ Chiamata fallback avviata');

        } catch (error) {
            console.error('❌ Errore chiamata fallback:', error);
            this.updateCallStatus('Call failed: ' + error.message);
            this.updateCallButtons(false);
        }
    },

    acceptCall: async function() {
        try {
            console.log('📞 Accettazione chiamata fallback...');
            this.updateCallStatus('Accepting call...');

            // Ottieni accesso al microfono
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Crea connessione peer
            this.peerConnection = new RTCPeerConnection(this.rtcConfiguration);
            this.setupPeerConnectionHandlers();

            // Aggiungi stream locale
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            this.isCallActive = true;
            this.updateCallButtons(true);
            this.updateCallStatus('Call active (fallback mode)');

            // Nascondi UI chiamata in arrivo
            this.hideIncomingCall();

            // Invia conferma accettazione
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({
                    action: 'call-accepted',
                    callId: this.currentCallId,
                    timestamp: Date.now()
                }));
            }

            console.log('✅ Chiamata fallback accettata');

        } catch (error) {
            console.error('❌ Errore accettazione chiamata fallback:', error);
            this.updateCallStatus('Failed to accept call');
            this.hideIncomingCall();
        }
    },

    declineCall: function() {
        console.log('📞 Rifiuto chiamata fallback');
        this.hideIncomingCall();

        // Invia conferma rifiuto
        if (window.ws && window.ws.readyState === WebSocket.OPEN) {
            window.ws.send(JSON.stringify({
                action: 'call-declined',
                callId: this.currentCallId,
                timestamp: Date.now()
            }));
        }

        this.currentCallId = null;
    },

    endCall: function() {
        try {
            console.log('📞 Terminazione chiamata fallback...');
            this.updateCallStatus('Ending call...');

            // Ferma stream locale
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
                this.localStream = null;
            }

            // Chiudi connessione peer
            if (this.peerConnection) {
                this.peerConnection.close();
                this.peerConnection = null;
            }

            this.isCallActive = false;
            this.updateCallButtons(false);
            this.updateCallStatus('Call ended');

            // Invia conferma fine chiamata
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({
                    action: 'call-ended',
                    callId: this.currentCallId,
                    timestamp: Date.now()
                }));
            }

            this.currentCallId = null;

            setTimeout(() => {
                this.updateCallStatus('Ready to call (fallback mode)');
            }, 2000);

            console.log('✅ Chiamata fallback terminata');

        } catch (error) {
            console.error('❌ Errore terminazione chiamata fallback:', error);
        }
    },

    toggleMute: function() {
        if (!this.localStream || !this.isCallActive) {
            return;
        }

        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            this.updateMuteButton(!audioTrack.enabled);
            this.updateCallStatus(audioTrack.enabled ? 'Microphone unmuted' : 'Microphone muted');

            setTimeout(() => {
                if (this.isCallActive) {
                    this.updateCallStatus('Call active (fallback mode)');
                }
            }, 2000);
        }
    },

    setupPeerConnectionHandlers: function() {
        if (!this.peerConnection) return;

        this.peerConnection.ontrack = (event) => {
            console.log('📞 Stream remoto ricevuto');
            this.remoteStream = event.streams[0];

            // Riproduci audio remoto
            const audioElement = document.createElement('audio');
            audioElement.srcObject = this.remoteStream;
            audioElement.autoplay = true;
            document.body.appendChild(audioElement);
        };

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && window.ws && window.ws.readyState === WebSocket.OPEN) {
                // In un'implementazione completa, invieresti i candidati ICE tramite WebSocket
                console.log('📞 ICE candidate generato');
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            console.log('📞 Stato connessione peer:', this.peerConnection.connectionState);
        };
    },

    signalIncomingCall: function() {
        const callData = {
            action: 'incoming-call',
            from: this.currentPageType,
            to: this.currentPageType === 'cucina' ? 'pizzeria' : 'cucina',
            callId: this.currentCallId,
            timestamp: Date.now()
        };

        if (window.ws && window.ws.readyState === WebSocket.OPEN) {
            window.ws.send(JSON.stringify(callData));
            console.log('📞 Segnalazione chiamata fallback inviata:', callData);
        }
    },

    showIncomingCall: function() {
        const incomingCallElement = document.getElementById('incomingCall');
        if (incomingCallElement) {
            incomingCallElement.style.display = 'flex';
        }
    },

    hideIncomingCall: function() {
        const incomingCallElement = document.getElementById('incomingCall');
        if (incomingCallElement) {
            incomingCallElement.style.display = 'none';
        }
    },

    // Funzioni di utilità per aggiornare l'UI
    updateConnectionStatus: function(status, text) {
        const statusElement = document.getElementById('connectionStatus');
        const statusText = document.getElementById('statusText');

        if (statusElement && statusText) {
            statusElement.className = 'status-indicator ' + status;
            statusText.textContent = text;
        }
    },

    updateCallStatus: function(status) {
        const callStatusElement = document.getElementById('callStatus');
        if (callStatusElement) {
            callStatusElement.textContent = status;
        }
    },

    updateCallButtons: function(inCall) {
        const callButton = document.getElementById('callButton');
        const hangupButton = document.getElementById('hangupButton');
        const muteButton = document.getElementById('muteButton');

        if (callButton) callButton.disabled = inCall;
        if (hangupButton) hangupButton.disabled = !inCall;
        if (muteButton) muteButton.disabled = !inCall;

        if (!inCall) {
            this.updateMuteButton(false);
        }
    },

    updateMuteButton: function(muted) {
        const muteButton = document.getElementById('muteButton');
        if (muteButton) {
            if (muted) {
                muteButton.classList.add('muted');
                muteButton.innerHTML = '<i class="fas fa-microphone-slash"></i> Unmute';
            } else {
                muteButton.classList.remove('muted');
                muteButton.innerHTML = '<i class="fas fa-microphone"></i> Mute';
            }
        }
    }
};

// Funzioni globali fallback per l'HTML
window.fallbackInitiateCall = function() {
    if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
        window.fallbackVoiceCall.initiateCall();
    } else {
        console.log('⚠️ Sistema fallback non inizializzato');
    }
};

window.fallbackAcceptCall = function() {
    if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
        window.fallbackVoiceCall.acceptCall();
    }
};

window.fallbackDeclineCall = function() {
    if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
        window.fallbackVoiceCall.declineCall();
    }
};

window.fallbackEndCall = function() {
    if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
        window.fallbackVoiceCall.endCall();
    }
};

window.fallbackToggleMute = function() {
    if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
        window.fallbackVoiceCall.toggleMute();
    }
};

// Gestione eventi chiamata via WebSocket per il fallback
window.addEventListener('DOMContentLoaded', function() {
    // Listener per messaggi WebSocket relativi alle chiamate
    if (window.ws) {
        const originalOnMessage = window.ws.onmessage;

        window.ws.onmessage = function(event) {
            if (originalOnMessage) {
                originalOnMessage.call(this, event);
            }

            try {
                const data = JSON.parse(event.data);

                if (window.fallbackVoiceCall && window.fallbackVoiceCall.isInitialized) {
                    if (data.action === 'incoming-call' && 
                        data.to === window.fallbackVoiceCall.currentPageType && 
                        !window.fallbackVoiceCall.isCallActive) {

                        window.fallbackVoiceCall.currentCallId = data.callId;
                        window.fallbackVoiceCall.showIncomingCall();
                        console.log('📞 Chiamata fallback in arrivo:', data);
                    }
                }
            } catch (error) {
                // Ignora errori di parsing
            }
        };
    }
});

console.log('📞 Sistema fallback chiamate caricato');