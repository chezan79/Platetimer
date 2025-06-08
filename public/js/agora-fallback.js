
// Sistema fallback per chiamate vocali senza Agora
window.fallbackVoiceCall = {
    isInitialized: false,
    isCallActive: false,
    isMuted: false,
    currentPageType: null,
    ws: null,
    currentCallId: null,
    
    initialize: function(pageType) {
        console.log('🔄 Inizializzazione sistema fallback per:', pageType);
        this.currentPageType = pageType;
        this.connectWebSocket();
        this.isInitialized = true;
        
        // Aggiorna status iniziale
        this.updateConnectionStatus('connected');
        this.updateCallStatus('Ready to call');
        
        console.log('✅ Sistema fallback inizializzato');
    },
    
    connectWebSocket: function() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        
        this.ws.onopen = () => {
            console.log('🔗 WebSocket connesso per chiamate');
            this.updateConnectionStatus('connected');
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleWebSocketMessage(data);
            } catch (error) {
                console.error('❌ Errore parsing messaggio WebSocket:', error);
            }
        };
        
        this.ws.onclose = () => {
            console.log('🔌 WebSocket disconnesso');
            this.updateConnectionStatus('disconnected');
        };
        
        this.ws.onerror = (error) => {
            console.error('❌ Errore WebSocket:', error);
            this.updateConnectionStatus('error');
        };
    },
    
    handleWebSocketMessage: function(data) {
        switch (data.action) {
            case 'incomingCall':
                this.showIncomingCall(data);
                break;
            case 'callResponse':
                this.handleCallResponse(data);
                break;
            case 'callEnded':
                this.endCall();
                break;
        }
    },
    
    showIncomingCall: function(data) {
        console.log('📞 Chiamata in arrivo:', data);
        
        const incomingCallDiv = document.getElementById('incomingCall');
        if (incomingCallDiv) {
            incomingCallDiv.style.display = 'block';
            this.currentCallId = data.callId;
            
            // Aggiorna testo della chiamata in arrivo
            const callText = incomingCallDiv.querySelector('h3');
            if (callText) {
                const fromName = data.from === 'cucina' ? 'Cucina' : 'Pizzeria';
                callText.innerHTML = `<i class="fas fa-phone-volume"></i> Incoming Call from ${fromName}`;
            }
            
            this.updateCallStatus('Incoming call...');
            this.addCallLog(`Incoming call from ${data.from}`, 'incoming');
        }
    },
    
    sendWebSocketMessage: function(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            console.error('❌ WebSocket non connesso');
        }
    },
    
    initiateCall: function() {
        if (!this.isInitialized) {
            console.error('❌ Sistema non inizializzato');
            return;
        }
        
        console.log('📞 Avvio chiamata fallback...');
        
        const targetPage = this.currentPageType === 'cucina' ? 'pizzeria' : 'cucina';
        
        this.sendWebSocketMessage({
            action: 'initiateCall',
            from: this.currentPageType,
            to: targetPage,
            timestamp: Date.now()
        });
        
        this.updateCallStatus('Calling...');
        this.updateUI(true);
        
        // Simula chiamata attiva dopo 2 secondi se non c'è risposta
        setTimeout(() => {
            if (!this.isCallActive) {
                this.isCallActive = true;
                this.updateCallStatus('Call active (simulated)');
                this.addCallLog(`Called ${targetPage}`, 'outgoing');
            }
        }, 2000);
    },
    
    acceptCall: function() {
        if (!this.currentCallId) return;
        
        console.log('✅ Chiamata accettata');
        
        this.sendWebSocketMessage({
            action: 'answerCall',
            callId: this.currentCallId,
            response: 'accept',
            from: this.currentPageType,
            timestamp: Date.now()
        });
        
        this.isCallActive = true;
        this.updateCallStatus('Call active');
        this.updateUI(true);
        this.hideIncomingCall();
        this.addCallLog('Call accepted', 'accepted');
    },
    
    declineCall: function() {
        if (!this.currentCallId) return;
        
        console.log('❌ Chiamata rifiutata');
        
        this.sendWebSocketMessage({
            action: 'answerCall',
            callId: this.currentCallId,
            response: 'decline',
            from: this.currentPageType,
            timestamp: Date.now()
        });
        
        this.hideIncomingCall();
        this.updateCallStatus('Call declined');
        this.addCallLog('Call declined', 'declined');
        
        setTimeout(() => {
            this.updateCallStatus('Ready to call');
        }, 3000);
    },
    
    endCall: function() {
        console.log('📞 Terminazione chiamata fallback');
        
        if (this.currentCallId) {
            this.sendWebSocketMessage({
                action: 'endCall',
                callId: this.currentCallId,
                from: this.currentPageType,
                timestamp: Date.now()
            });
        }
        
        this.isCallActive = false;
        this.isMuted = false;
        this.currentCallId = null;
        
        this.updateCallStatus('Call ended');
        this.updateUI(false);
        this.hideIncomingCall();
        this.addCallLog('Call ended', 'ended');
        
        setTimeout(() => {
            this.updateCallStatus('Ready to call');
        }, 2000);
    },
    
    toggleMute: function() {
        this.isMuted = !this.isMuted;
        
        const muteButton = document.getElementById('muteButton');
        if (muteButton) {
            if (this.isMuted) {
                muteButton.innerHTML = '<i class="fas fa-microphone-slash"></i> Unmute';
                this.updateCallStatus('Muted');
            } else {
                muteButton.innerHTML = '<i class="fas fa-microphone"></i> Mute';
                this.updateCallStatus('Call active');
            }
        }
        
        console.log(this.isMuted ? '🔇 Microfono mutato' : '🎤 Microfono riattivato');
    },
    
    handleCallResponse: function(data) {
        if (data.response === 'accept') {
            this.isCallActive = true;
            this.updateCallStatus('Call active');
            this.updateUI(true);
            this.addCallLog('Call accepted by remote', 'accepted');
        } else if (data.response === 'decline') {
            this.updateCallStatus('Call declined by remote');
            this.updateUI(false);
            this.addCallLog('Call declined by remote', 'declined');
            
            setTimeout(() => {
                this.updateCallStatus('Ready to call');
            }, 3000);
        }
    },
    
    updateUI: function(callActive) {
        const callButton = document.getElementById('callButton');
        const hangupButton = document.getElementById('hangupButton');
        const muteButton = document.getElementById('muteButton');
        
        if (callButton) callButton.disabled = callActive;
        if (hangupButton) hangupButton.disabled = !callActive;
        if (muteButton) {
            muteButton.disabled = !callActive;
            if (!callActive) {
                muteButton.innerHTML = '<i class="fas fa-microphone"></i> Mute';
            }
        }
    },
    
    hideIncomingCall: function() {
        const incomingCallDiv = document.getElementById('incomingCall');
        if (incomingCallDiv) {
            incomingCallDiv.style.display = 'none';
        }
    },
    
    updateConnectionStatus: function(status) {
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
    },
    
    updateCallStatus: function(status) {
        const callStatusElement = document.getElementById('callStatus');
        if (callStatusElement) {
            callStatusElement.textContent = status;
        }
    },
    
    addCallLog: function(message, type) {
        const callLogsDiv = document.getElementById('callLogs');
        if (!callLogsDiv) return;
        
        // Rimuovi il messaggio "No recent calls" se presente
        const noLogsP = callLogsDiv.querySelector('.no-logs');
        if (noLogsP) {
            noLogsP.remove();
        }
        
        const logEntry = document.createElement('div');
        logEntry.className = `call-log-entry ${type}`;
        logEntry.style.cssText = `
            padding: 8px 12px;
            margin: 4px 0;
            border-radius: 6px;
            font-size: 14px;
            border-left: 4px solid;
        `;
        
        // Colori in base al tipo
        switch (type) {
            case 'incoming':
                logEntry.style.backgroundColor = '#e3f2fd';
                logEntry.style.borderLeftColor = '#2196f3';
                break;
            case 'outgoing':
                logEntry.style.backgroundColor = '#e8f5e8';
                logEntry.style.borderLeftColor = '#28a745';
                break;
            case 'accepted':
                logEntry.style.backgroundColor = '#e8f5e8';
                logEntry.style.borderLeftColor = '#28a745';
                break;
            case 'declined':
                logEntry.style.backgroundColor = '#ffeaa7';
                logEntry.style.borderLeftColor = '#fdcb6e';
                break;
            case 'ended':
                logEntry.style.backgroundColor = '#f8f9fa';
                logEntry.style.borderLeftColor = '#6c757d';
                break;
        }
        
        const timestamp = new Date().toLocaleTimeString('it-IT');
        logEntry.innerHTML = `
            <div style="font-weight: 600;">${message}</div>
            <div style="font-size: 12px; color: #666; margin-top: 2px;">${timestamp}</div>
        `;
        
        callLogsDiv.appendChild(logEntry);
        
        // Mantieni solo gli ultimi 10 log
        const logs = callLogsDiv.querySelectorAll('.call-log-entry');
        if (logs.length > 10) {
            logs[0].remove();
        }
        
        // Scroll automatico al bottom
        callLogsDiv.scrollTop = callLogsDiv.scrollHeight;
    }
};

// Funzioni globali per compatibilità con HTML
function fallbackInitiateCall() {
    // Prova prima Agora, poi fallback
    if (window.agoraClient && window.AGORA_APP_ID && window.AGORA_APP_ID !== 'your-agora-app-id') {
        console.log('🎤 Usando Agora per la chiamata');
        window.initiateAgoraCall();
    } else {
        console.log('🔄 Usando sistema fallback per la chiamata');
        window.fallbackVoiceCall.initiateCall();
    }
}

function fallbackEndCall() {
    if (window.agoraClient && window.isCallActive) {
        console.log('🎤 Terminando chiamata Agora');
        window.endAgoraCall();
    } else {
        console.log('🔄 Terminando chiamata fallback');
        window.fallbackVoiceCall.endCall();
    }
}

function fallbackToggleMute() {
    if (window.agoraClient && window.isCallActive) {
        console.log('🎤 Toggle mute Agora');
        window.toggleAgoraMute();
    } else {
        console.log('🔄 Toggle mute fallback');
        window.fallbackVoiceCall.toggleMute();
    }
}

function fallbackAcceptCall() {
    window.fallbackVoiceCall.acceptCall();
}

function declineCall() {
    window.fallbackVoiceCall.declineCall();
}

// Funzione per regolare volume (per entrambi i sistemi)
function adjustVolume(value) {
    const volumeValue = document.getElementById('volumeValue');
    if (volumeValue) {
        volumeValue.textContent = `${value}%`;
    }
    
    // Se Agora è attivo, usa la sua funzione
    if (window.adjustVolume && window.agoraClient) {
        window.adjustVolume(value);
    }
    
    console.log('🔊 Volume impostato a:', value + '%');
}
