// Multi-level fallback voice communication system
let localConnection = null;
let remoteConnection = null;
let localStream = null;
let dataChannel = null;

// Fallback connection tracking
let fallbackLevel = 0;
let connectionAttempts = 0;
let maxConnectionAttempts = 5;
let reconnectInterval = null;
let healthCheckInterval = null;

// Enhanced WebRTC configuration with multiple fallback levels
const rtcConfigs = [
    // Level 0: Standard configuration
    {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    },
    // Level 1: More aggressive ICE gathering
    {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.nextcloud.com:443' },
            { urls: 'stun:stun.sipgate.net:3478' }
        ],
        iceCandidatePoolSize: 20,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all'
    },
    // Level 2: Relay-only fallback
    {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 5,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'relay'
    }
];

// Enhanced fallback voice call system with multi-level recovery
class FallbackVoiceCall {
    constructor() {
        this.isActive = false;
        this.isMuted = false;
        this.currentPageType = null;
        this.connectionHealth = {
            lastSuccessfulConnection: null,
            failedAttempts: 0,
            currentMethod: 'websocket'
        };
        this.signalMethods = ['websocket', 'localStorage', 'polling'];
        this.currentSignalMethod = 0;
        this.signalBuffer = [];
        this.signalRetryQueue = [];
    }

    async initialize(pageType) {
        this.currentPageType = pageType;
        console.log('🔧 Initializing enhanced fallback voice system for:', pageType);

        // Initialize all signaling methods
        this.initializeSignaling();
        
        // Start connection health monitoring
        this.startHealthMonitoring();

        updateConnectionStatus('disconnected', 'Enhanced fallback system ready');
        return true;
    }

    startHealthMonitoring() {
        // Monitor connection health every 10 seconds
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        
        healthCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Monitor WebSocket specifically
        this.monitorWebSocket();
    }

    checkConnectionHealth() {
        const now = Date.now();
        const wsConnected = window.socket && window.socket.readyState === WebSocket.OPEN;
        
        if (!wsConnected) {
            this.connectionHealth.failedAttempts++;
            console.log(`⚠️ Connection health check failed (${this.connectionHealth.failedAttempts} failures)`);
            
            if (this.connectionHealth.failedAttempts >= 3) {
                this.escalateSignalingMethod();
            }
        } else {
            if (this.connectionHealth.failedAttempts > 0) {
                console.log('✅ Connection health restored');
            }
            this.connectionHealth.failedAttempts = 0;
            this.connectionHealth.lastSuccessfulConnection = now;
        }
    }

    escalateSignalingMethod() {
        if (this.currentSignalMethod < this.signalMethods.length - 1) {
            this.currentSignalMethod++;
            const newMethod = this.signalMethods[this.currentSignalMethod];
            console.log(`📡 Escalating to signaling method: ${newMethod}`);
            updateConnectionStatus('connecting', `Switching to ${newMethod} signaling`);
            
            // Retry buffered signals with new method
            this.retryBufferedSignals();
        }
    }

    monitorWebSocket() {
        if (!window.socket) return;

        const originalOnClose = window.socket.onclose;
        window.socket.onclose = (event) => {
            console.log('🔌 WebSocket closed, initiating fallback recovery');
            this.handleWebSocketDisconnection();
            if (originalOnClose) originalOnClose.call(window.socket, event);
        };

        const originalOnError = window.socket.onerror;
        window.socket.onerror = (error) => {
            console.error('❌ WebSocket error, preparing fallback');
            this.connectionHealth.failedAttempts++;
            if (originalOnError) originalOnError.call(window.socket, error);
        };
    }

    handleWebSocketDisconnection() {
        if (this.isActive) {
            console.log('📞 Call active during disconnection, maintaining with fallback');
            updateCallStatus('Connection lost - Using fallback');
            
            // Switch to localStorage signaling immediately
            this.currentSignalMethod = 1;
            this.connectionHealth.currentMethod = 'localStorage';
        }
    }

    async startCall() {
        if (this.isActive) {
            console.log('Call already active');
            return;
        }

        console.log('🚀 Starting enhanced fallback call...');
        updateCallStatus('Initiating call...');
        connectionAttempts = 0;
        fallbackLevel = 0;

        return this.attemptCallWithFallback();
    }

    async attemptCallWithFallback() {
        const maxAttempts = rtcConfigs.length;
        
        while (fallbackLevel < maxAttempts && connectionAttempts < maxConnectionAttempts) {
            try {
                connectionAttempts++;
                console.log(`📞 Call attempt ${connectionAttempts} using fallback level ${fallbackLevel}`);
                
                const success = await this.initializeCall(fallbackLevel);
                if (success) {
                    console.log(`✅ Call established with fallback level ${fallbackLevel}`);
                    return true;
                }
            } catch (error) {
                console.error(`❌ Call attempt ${connectionAttempts} failed:`, error);
                updateCallStatus(`Attempt ${connectionAttempts} failed, trying alternative...`);
            }

            // Try next fallback level
            fallbackLevel++;
            if (fallbackLevel < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.error('❌ All fallback attempts failed');
        updateCallStatus('Call failed - All methods exhausted');
        showError('Unable to establish call. Please check your network connection and try again.');
        return false;
    }

    async initializeCall(level) {
        // Enhanced audio constraints for cross-device compatibility
        const audioConstraints = this.getAudioConstraints(level);

        // Get user media with retry mechanism
        localStream = await this.getUserMediaWithRetry(audioConstraints);

        // Create peer connection with current fallback level configuration
        localConnection = new RTCPeerConnection(rtcConfigs[level]);

        // Add local stream
        localStream.getTracks().forEach(track => {
            localConnection.addTrack(track, localStream);
            console.log(`Added track (level ${level}):`, track.kind, track.label);
        });

        // Create data channel for signaling
        dataChannel = localConnection.createDataChannel('signaling', {
            ordered: true,
            maxRetransmits: level > 0 ? 5 : 3 // More retries for higher fallback levels
        });

        // Set up event handlers with enhanced error handling
        this.setupConnectionHandlers(localConnection, true, level);

        // Create offer with enhanced options
        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: false,
            voiceActivityDetection: true
        };

        const offer = await localConnection.createOffer(offerOptions);
        await localConnection.setLocalDescription(offer);

        // Send offer through signaling with fallback info
        this.sendSignal({
            type: 'offer',
            offer: offer,
            from: this.currentPageType,
            timestamp: Date.now(),
            fallbackLevel: level,
            deviceType: this.getDeviceType()
        });

        this.isActive = true;
        updateCallButtons(true);
        updateCallStatus(`Calling... (method ${level + 1})`);
        logCall('outgoing', `Fallback call initiated (level ${level})`);

        return true;
    }

    getAudioConstraints(level) {
        const baseConstraints = {
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
            baseConstraints.audio.sampleRate = 48000;
            baseConstraints.audio.latency = 0.1;
        }

        // Adjust constraints based on fallback level
        if (level > 0) {
            baseConstraints.audio.sampleRate = Math.min(baseConstraints.audio.sampleRate, 24000);
            baseConstraints.audio.channelCount = 1; // Force mono for better compatibility
        }

        if (level > 1) {
            // Most basic settings for maximum compatibility
            baseConstraints.audio = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            };
        }

        return baseConstraints;
    }

    async getUserMediaWithRetry(audioConstraints) {
        let retries = 5;
        let lastError = null;

        while (retries > 0) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
                console.log(`✅ Got local audio stream on attempt ${6 - retries}`);
                return stream;
            } catch (error) {
                lastError = error;
                retries--;
                console.log(`⚠️ getUserMedia failed, ${retries} attempts left:`, error.message);
                
                if (retries > 0) {
                    // Try with more relaxed constraints
                    if (audioConstraints.audio.sampleRate) {
                        audioConstraints.audio.sampleRate = Math.min(audioConstraints.audio.sampleRate, 22050);
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000 * (6 - retries)));
                }
            }
        }

        throw lastError;
    }

    getDeviceType() {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        const isAndroid = /Android/.test(navigator.userAgent);
        const isMobile = /Mobile|Tablet/.test(navigator.userAgent);

        if (isIOS) return 'ios';
        if (isSafari) return 'safari';
        if (isAndroid) return 'android';
        if (isMobile) return 'mobile';
        return 'desktop';
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
        
        // Add to retry queue for resilience
        const signalId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        const signalPacket = {
            id: signalId,
            data: data,
            targetPage: targetPage,
            attempts: 0,
            timestamp: Date.now(),
            method: this.signalMethods[this.currentSignalMethod]
        };

        this.signalRetryQueue.push(signalPacket);
        this.processSignalQueue();
    }

    async processSignalQueue() {
        if (this.signalRetryQueue.length === 0) return;

        const signal = this.signalRetryQueue[0];
        const success = await this.sendSignalWithMethod(signal);

        if (success) {
            this.signalRetryQueue.shift();
            console.log(`✅ Signal sent successfully (${signal.method}):`, signal.data.type);
        } else {
            signal.attempts++;
            if (signal.attempts >= 3) {
                console.warn(`❌ Signal failed after ${signal.attempts} attempts:`, signal.data.type);
                this.signalRetryQueue.shift();
                
                // Try next signaling method
                if (this.currentSignalMethod < this.signalMethods.length - 1) {
                    this.escalateSignalingMethod();
                }
            } else {
                console.log(`🔄 Retrying signal (attempt ${signal.attempts + 1}):`, signal.data.type);
                setTimeout(() => this.processSignalQueue(), 2000 * signal.attempts);
            }
        }

        // Process next signal in queue
        if (this.signalRetryQueue.length > 0) {
            setTimeout(() => this.processSignalQueue(), 100);
        }
    }

    async sendSignalWithMethod(signalPacket) {
        const { data, targetPage } = signalPacket;
        const method = this.signalMethods[this.currentSignalMethod];

        try {
            switch (method) {
                case 'websocket':
                    return await this.sendViaWebSocket(data, targetPage);
                case 'localStorage':
                    return await this.sendViaLocalStorage(data, targetPage);
                case 'polling':
                    return await this.sendViaPolling(data, targetPage);
                default:
                    return false;
            }
        } catch (error) {
            console.error(`❌ Signal method ${method} failed:`, error);
            return false;
        }
    }

    async sendViaWebSocket(data, targetPage) {
        if (!window.socket || window.socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            const payload = {
                action: 'webrtcSignal',
                targetPage: targetPage,
                signalData: data,
                timestamp: Date.now(),
                fromDevice: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop',
                fallbackLevel: fallbackLevel
            };

            window.socket.send(JSON.stringify(payload));
            console.log('📡 WebRTC signal sent via WebSocket:', data.type, 'to', targetPage);
            return true;
        } catch (error) {
            console.error('❌ WebSocket send failed:', error);
            return false;
        }
    }

    async sendViaLocalStorage(data, targetPage) {
        try {
            const signalKey = `webrtc-signal-${targetPage}`;
            const signalData = {
                ...data,
                deviceInfo: {
                    userAgent: navigator.userAgent,
                    timestamp: Date.now(),
                    isMobile: /Mobile|Tablet|iPad|iPhone|Android/.test(navigator.userAgent),
                    isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
                    fallbackLevel: fallbackLevel
                }
            };
            
            localStorage.setItem(signalKey, JSON.stringify(signalData));

            // Trigger storage event for same-origin pages
            window.dispatchEvent(new StorageEvent('storage', {
                key: signalKey,
                newValue: JSON.stringify(signalData)
            }));

            console.log('💾 WebRTC signal sent via localStorage:', data.type, 'to', targetPage);
            return true;
        } catch (error) {
            console.error('❌ localStorage send failed:', error);
            return false;
        }
    }

    async sendViaPolling(data, targetPage) {
        try {
            // Use server API as last resort
            const response = await fetch('/api/signal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'webrtcSignal',
                    targetPage: targetPage,
                    signalData: data,
                    timestamp: Date.now(),
                    fromDevice: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop'
                })
            });

            if (response.ok) {
                console.log('🌐 WebRTC signal sent via HTTP polling:', data.type, 'to', targetPage);
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ HTTP polling send failed:', error);
            return false;
        }
    }

    retryBufferedSignals() {
        if (this.signalBuffer.length > 0) {
            console.log(`🔄 Retrying ${this.signalBuffer.length} buffered signals`);
            this.signalBuffer.forEach(signal => {
                this.signalRetryQueue.push(signal);
            });
            this.signalBuffer = [];
            this.processSignalQueue();
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