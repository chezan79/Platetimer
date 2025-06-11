// Sistema Fallback per chiamate vocali WebRTC
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
        this.updateConnectionStatus('connected', 'Fallback system ready');
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
                this.updateCallStatus('Ready to call');
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
                    this.updateCallStatus('Call active');
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
            audioElement.style.display = 'none';
            document.body.appendChild(audioElement);
        };

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && window.ws && window.ws.readyState === WebSocket.OPEN) {
                console.log('📞 ICE candidate generato');
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            console.log('📞 Stato connessione peer:', this.peerConnection.connectionState);
            if (this.peerConnection.connectionState === 'connected') {
                this.updateCallStatus('Call active - Connected');
            }
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
            console.log('📞 Mostra UI chiamata in arrivo');
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

console.log('📞 Sistema fallback chiamate caricato correttamente');