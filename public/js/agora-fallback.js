// Fallback voice communication using WebRTC peer-to-peer
let localConnection = null;
let remoteConnection = null;
let localStream = null;
let dataChannel = null;

// Enhanced WebRTC configuration for cross-device compatibility
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
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
            // Enhanced audio constraints for cross-device compatibility
            const audioConstraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 44100,
                    channelCount: 1
                }
            };

            // iOS/Safari specific adjustments
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            
            if (isIOS || isSafari) {
                console.log('📱 Detected iOS/Safari, adjusting audio constraints');
                audioConstraints.audio.sampleRate = 48000;
                audioConstraints.audio.latency = 0.1;
            }

            // Get user media with retry mechanism
            let retries = 3;
            while (retries > 0) {
                try {
                    localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
                    console.log('✅ Got local audio stream on attempt', 4 - retries);
                    break;
                } catch (error) {
                    retries--;
                    if (retries === 0) throw error;
                    console.log('⚠️ Retrying getUserMedia, attempts left:', retries);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Create peer connection with enhanced configuration
            localConnection = new RTCPeerConnection(rtcConfig);

            // Add local stream
            localStream.getTracks().forEach(track => {
                localConnection.addTrack(track, localStream);
                console.log('Added track:', track.kind, track.label);
            });

            // Create data channel for signaling
            dataChannel = localConnection.createDataChannel('signaling', {
                ordered: true
            });

            // Set up event handlers
            this.setupConnectionHandlers(localConnection, true);

            // Create offer with enhanced options
            const offerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
                voiceActivityDetection: true
            };

            const offer = await localConnection.createOffer(offerOptions);
            await localConnection.setLocalDescription(offer);

            // Send offer through signaling
            this.sendSignal({
                type: 'offer',
                offer: offer,
                from: this.currentPageType,
                timestamp: Date.now(),
                deviceType: isIOS ? 'ios' : isSafari ? 'safari' : 'other'
            });

            this.isActive = true;
            updateCallButtons(true);
            updateCallStatus('Calling...');
            logCall('outgoing', 'Fallback call initiated');

        } catch (error) {
            console.error('Failed to start fallback call:', error);
            updateCallStatus('Call failed');
            
            let errorMessage = 'Failed to access microphone: ' + error.message;
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Microphone access denied. Please allow microphone access and try again.';
            } else if (error.name === 'NotFoundError') {
                errorMessage = 'No microphone found. Please check your device settings.';
            }
            
            showError(errorMessage);
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
        
        // Add retry mechanism for WebSocket
        const sendViaWebSocket = (retries = 3) => {
            if (window.socket && window.socket.readyState === WebSocket.OPEN) {
                try {
                    window.socket.send(JSON.stringify({
                        action: 'webrtcSignal',
                        targetPage: targetPage,
                        signalData: data,
                        timestamp: Date.now(),
                        fromDevice: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop'
                    }));
                    console.log('📡 WebRTC signal sent via WebSocket:', data.type, 'to', targetPage);
                    return true;
                } catch (error) {
                    console.error('❌ WebSocket send failed:', error);
                    if (retries > 0) {
                        setTimeout(() => sendViaWebSocket(retries - 1), 1000);
                    }
                    return false;
                }
            } else if (retries > 0) {
                console.log('🔄 WebSocket not ready, retrying...');
                setTimeout(() => sendViaWebSocket(retries - 1), 1000);
                return false;
            }
            return false;
        };

        const sent = sendViaWebSocket();

        // Enhanced localStorage fallback with device info
        const signalKey = `webrtc-signal-${targetPage}`;
        const signalData = {
            ...data,
            deviceInfo: {
                userAgent: navigator.userAgent,
                timestamp: Date.now(),
                isMobile: /Mobile|Tablet|iPad|iPhone|Android/.test(navigator.userAgent),
                isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent)
            }
        };
        
        localStorage.setItem(signalKey, JSON.stringify(signalData));

        // Trigger storage event for same-origin pages
        try {
            window.dispatchEvent(new StorageEvent('storage', {
                key: signalKey,
                newValue: JSON.stringify(signalData)
            }));
        } catch (e) {
            console.log('Storage event dispatch failed:', e);
        }

        if (!sent) {
            console.warn('⚠️ WebSocket unavailable, relying on localStorage fallback');
        }
    }

    listenForSignaling() {
        const signalKey = `webrtc-signal-${this.currentPageType}`;

        // Enhanced WebSocket listener with better error handling
        if (window.socket) {
            const originalOnMessage = window.socket.onmessage;
            window.socket.onmessage = function(event) {
                // Call original handler first
                if (originalOnMessage) {
                    originalOnMessage.call(this, event);
                }
                
                try {
                    const data = JSON.parse(event.data);
                    if (data.action === 'webrtcSignal' && 
                        data.targetPage === this.currentPageType && 
                        data.signalData) {
                        console.log('📡 WebRTC signal received via WebSocket:', data.signalData.type, 'from device:', data.fromDevice || 'unknown');
                        this.handleSignal(data.signalData);
                    }
                } catch (error) {
                    // Ignore parsing errors for non-WebRTC messages
                }
            }.bind(this);

            // Monitor WebSocket connection status
            window.socket.addEventListener('close', () => {
                console.log('🔌 WebSocket closed, WebRTC signals will use localStorage fallback');
            });

            window.socket.addEventListener('error', (error) => {
                console.error('❌ WebSocket error:', error);
            });
        }

        // Enhanced localStorage listener with device compatibility
        window.addEventListener('storage', async (event) => {
            if (event.key === signalKey && event.newValue) {
                try {
                    const signal = JSON.parse(event.newValue);
                    console.log('📡 WebRTC signal received via localStorage:', signal.type, 'from device:', signal.deviceInfo?.isMobile ? 'mobile' : 'desktop');
                    await this.handleSignal(signal);
                    // Clear the signal after processing
                    localStorage.removeItem(signalKey);
                } catch (error) {
                    console.error('Error processing localStorage signal:', error);
                    localStorage.removeItem(signalKey); // Clear corrupted signal
                }
            }
        });

        // Check periodically for signals with enhanced validation
        setInterval(() => {
            const signalData = localStorage.getItem(signalKey);
            if (signalData) {
                try {
                    const signal = JSON.parse(signalData);
                    const now = Date.now();
                    const signalAge = now - (signal.timestamp || signal.deviceInfo?.timestamp || 0);
                    
                    if (signalAge < 60000) { // 60 second timeout (era 30)
                        console.log('📡 Processing periodic WebRTC signal:', signal.type);
                        this.handleSignal(signal);
                    } else {
                        console.log('🗑️ Removing expired WebRTC signal:', signal.type, 'age:', Math.floor(signalAge/1000), 'seconds');
                    }
                    localStorage.removeItem(signalKey);
                } catch (error) {
                    console.error('Error in periodic signal check:', error);
                    localStorage.removeItem(signalKey); // Clear corrupted signal
                }
            }

            // Monitora stato WebSocket e riconnetti se necessario
            if (window.socket && window.socket.readyState === WebSocket.CLOSED) {
                console.log('🔄 WebSocket disconnesso, tentativo riconnessione...');
                // Trigghera riconnessione se esiste una funzione globale
                if (typeof window.connectWebSocket === 'function') {
                    window.connectWebSocket();
                }
            }
        }, 5000); // Check every 5 seconds (era 2)
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