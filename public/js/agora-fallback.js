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