const VoiceCall = (() => {
    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    const AUDIO_CONSTRAINTS = {
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    };

    let ws = null;
    let localStream = null;
    let peerConnections = new Map();
    let roomId = null;
    let myPeerId = null;
    let isMuted = false;
    let masterVolume = 1.0;
    let isInCall = false;
    let wsReconnectAttempts = 0;
    let wsReconnectTimer = null;

    const callbacks = {
        onStateChanged: null,
        onPeersChanged: null,
        onError: null
    };

    function log(message, ...args) {
        console.log(`[VOICE] ${message}`, ...args);
    }

    function error(message, ...args) {
        console.error(`[VOICE ERROR] ${message}`, ...args);
        if (callbacks.onError) {
            callbacks.onError(message);
        }
    }

    function generatePeerId(label) {
        const random = Math.random().toString(36).substring(2, 9);
        return `${label.toUpperCase()}-${random}`;
    }

    async function getLocalStream() {
        if (localStream) {
            return localStream;
        }

        try {
            localStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
            log('Local audio stream obtained');
            
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });

            return localStream;
        } catch (err) {
            error('Failed to get local audio stream:', err);
            throw new Error('Microfono non accessibile. Controlla i permessi del browser.');
        }
    }

    function createPeerConnection(remotePeerId) {
        log(`Creating peer connection to ${remotePeerId}`);
        
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.onicecandidate = (event) => {
            if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'ice-candidate',
                    to: remotePeerId,
                    from: myPeerId,
                    candidate: event.candidate
                }));
            }
        };

        pc.ontrack = (event) => {
            log(`Received remote track from ${remotePeerId}`);
            handleRemoteTrack(remotePeerId, event.streams[0]);
        };

        pc.onconnectionstatechange = () => {
            log(`Connection state with ${remotePeerId}: ${pc.connectionState}`);
            
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                setTimeout(() => {
                    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                        log(`Attempting to reconnect with ${remotePeerId}`);
                        peerConnections.delete(remotePeerId);
                        removeRemoteAudio(remotePeerId);
                        updatePeersUI();
                    }
                }, 3000);
            }

            if (pc.connectionState === 'connected') {
                updatePeersUI();
            }
        };

        pc.oniceconnectionstatechange = () => {
            log(`ICE state with ${remotePeerId}: ${pc.iceConnectionState}`);
        };

        return pc;
    }

    async function createOffer(remotePeerId) {
        try {
            const pc = peerConnections.get(remotePeerId);
            if (!pc) return;

            const stream = await getLocalStream();
            stream.getTracks().forEach(track => {
                pc.addTrack(track, stream);
            });

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'offer',
                    to: remotePeerId,
                    from: myPeerId,
                    sdp: offer
                }));
                log(`Sent offer to ${remotePeerId}`);
            }
        } catch (err) {
            error(`Failed to create offer for ${remotePeerId}:`, err);
        }
    }

    async function handleOffer(remotePeerId, offer) {
        try {
            log(`Handling offer from ${remotePeerId}`);
            
            let pc = peerConnections.get(remotePeerId);
            if (!pc) {
                pc = createPeerConnection(remotePeerId);
                peerConnections.set(remotePeerId, pc);
            }

            const stream = await getLocalStream();
            stream.getTracks().forEach(track => {
                pc.addTrack(track, stream);
            });

            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'answer',
                    to: remotePeerId,
                    from: myPeerId,
                    sdp: answer
                }));
                log(`Sent answer to ${remotePeerId}`);
            }
        } catch (err) {
            error(`Failed to handle offer from ${remotePeerId}:`, err);
        }
    }

    async function handleAnswer(remotePeerId, answer) {
        try {
            log(`Handling answer from ${remotePeerId}`);
            const pc = peerConnections.get(remotePeerId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
            }
        } catch (err) {
            error(`Failed to handle answer from ${remotePeerId}:`, err);
        }
    }

    async function handleIceCandidate(remotePeerId, candidate) {
        try {
            const pc = peerConnections.get(remotePeerId);
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (err) {
            error(`Failed to add ICE candidate from ${remotePeerId}:`, err);
        }
    }

    function handleRemoteTrack(remotePeerId, stream) {
        let audioElement = document.getElementById(`remote-audio-${remotePeerId}`);
        
        if (!audioElement) {
            audioElement = document.createElement('audio');
            audioElement.id = `remote-audio-${remotePeerId}`;
            audioElement.autoplay = true;
            audioElement.playsinline = true;
            audioElement.volume = masterVolume;
            
            const container = document.getElementById('remote-audios');
            if (container) {
                container.appendChild(audioElement);
            } else {
                document.body.appendChild(audioElement);
            }
        }

        audioElement.srcObject = stream;
        log(`Remote audio element created/updated for ${remotePeerId}`);
        updatePeersUI();
    }

    function removeRemoteAudio(remotePeerId) {
        const audioElement = document.getElementById(`remote-audio-${remotePeerId}`);
        if (audioElement) {
            audioElement.srcObject = null;
            audioElement.remove();
            log(`Remote audio element removed for ${remotePeerId}`);
        }
    }

    function handlePeerJoined(remotePeerId) {
        log(`Peer joined: ${remotePeerId}`);
        
        if (!peerConnections.has(remotePeerId)) {
            const pc = createPeerConnection(remotePeerId);
            peerConnections.set(remotePeerId, pc);
            createOffer(remotePeerId);
        }
        
        updatePeersUI();
    }

    function handlePeerLeft(remotePeerId) {
        log(`Peer left: ${remotePeerId}`);
        
        const pc = peerConnections.get(remotePeerId);
        if (pc) {
            pc.close();
            peerConnections.delete(remotePeerId);
        }
        
        removeRemoteAudio(remotePeerId);
        updatePeersUI();
    }

    function connectWebSocket(existingWs) {
        if (existingWs) {
            ws = existingWs;
            setupWebSocketHandlers();
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        
        ws.onopen = () => {
            log('WebSocket connected for voice');
            wsReconnectAttempts = 0;
            setupWebSocketHandlers();
        };

        ws.onclose = () => {
            log('WebSocket disconnected');
            attemptReconnect();
        };

        ws.onerror = (err) => {
            error('WebSocket error:', err);
        };
    }

    function setupWebSocketHandlers() {
        const originalOnMessage = ws.onmessage;
        
        ws.onmessage = (event) => {
            if (originalOnMessage) {
                originalOnMessage(event);
            }

            try {
                const data = JSON.parse(event.data);
                
                if (data.action === 'voicePeers') {
                    log('Received existing peers:', data.peers);
                    data.peers.forEach(peerId => {
                        handlePeerJoined(peerId);
                    });
                } else if (data.action === 'voicePeerJoined') {
                    handlePeerJoined(data.peerId);
                } else if (data.action === 'voicePeerLeft') {
                    handlePeerLeft(data.peerId);
                } else if (data.action === 'offer') {
                    handleOffer(data.from, data.sdp);
                } else if (data.action === 'answer') {
                    handleAnswer(data.from, data.sdp);
                } else if (data.action === 'ice-candidate') {
                    handleIceCandidate(data.from, data.candidate);
                } else if (data.action === 'mute' || data.action === 'unmute') {
                    updatePeerMuteStatus(data.peerId, data.action === 'mute');
                }
            } catch (err) {
                error('Failed to parse WebSocket message:', err);
            }
        };
    }

    function attemptReconnect() {
        if (wsReconnectTimer || !isInCall) return;

        wsReconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
        
        log(`Reconnecting WebSocket in ${delay}ms (attempt ${wsReconnectAttempts})`);
        
        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWebSocket();
        }, delay);
    }

    function updatePeersUI() {
        if (callbacks.onPeersChanged) {
            const activePeers = Array.from(peerConnections.keys()).filter(peerId => {
                const pc = peerConnections.get(peerId);
                return pc && pc.connectionState === 'connected';
            });
            callbacks.onPeersChanged(activePeers);
        }
    }

    function updatePeerMuteStatus(peerId, muted) {
        log(`Peer ${peerId} is now ${muted ? 'muted' : 'unmuted'}`);
        updatePeersUI();
    }

    function updateState(state) {
        if (callbacks.onStateChanged) {
            callbacks.onStateChanged(state);
        }
    }

    async function joinVoice(room, peerLabel, existingWs = null) {
        try {
            log(`Joining voice room: ${room} as ${peerLabel}`);
            
            roomId = room;
            myPeerId = generatePeerId(peerLabel);
            isInCall = true;

            await getLocalStream();

            if (existingWs) {
                connectWebSocket(existingWs);
            } else {
                connectWebSocket();
            }

            if (ws.readyState === WebSocket.OPEN) {
                sendJoinMessage();
            } else {
                ws.addEventListener('open', sendJoinMessage, { once: true });
            }

            updateState('connected');
            log(`Successfully joined voice room as ${myPeerId}`);
            
            return { success: true, peerId: myPeerId };
        } catch (err) {
            error('Failed to join voice:', err);
            isInCall = false;
            updateState('error');
            throw err;
        }
    }

    function sendJoinMessage() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                action: 'joinVoice',
                room: roomId,
                peerId: myPeerId
            }));
        }
    }

    function leaveVoice() {
        try {
            log('Leaving voice room');
            isInCall = false;

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'leaveVoice',
                    peerId: myPeerId
                }));
            }

            peerConnections.forEach((pc, peerId) => {
                pc.close();
                removeRemoteAudio(peerId);
            });
            peerConnections.clear();

            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }

            roomId = null;
            myPeerId = null;

            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }

            updateState('disconnected');
            updatePeersUI();
            
            log('Successfully left voice room');
        } catch (err) {
            error('Error leaving voice:', err);
        }
    }

    function toggleMute() {
        if (!localStream) return false;

        isMuted = !isMuted;
        
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                action: isMuted ? 'mute' : 'unmute',
                peerId: myPeerId
            }));
        }

        log(`Microphone ${isMuted ? 'muted' : 'unmuted'}`);
        updateState(isMuted ? 'muted' : 'unmuted');
        
        return isMuted;
    }

    function setVolume(volume) {
        masterVolume = Math.max(0, Math.min(1, volume));
        
        document.querySelectorAll('audio[id^="remote-audio-"]').forEach(audio => {
            audio.volume = masterVolume;
        });

        log(`Volume set to ${Math.round(masterVolume * 100)}%`);
        
        localStorage.setItem('voiceCallVolume', masterVolume);
    }

    function getVolume() {
        return masterVolume;
    }

    function isMutedState() {
        return isMuted;
    }

    function isConnected() {
        return isInCall && peerConnections.size > 0;
    }

    function getActivePeers() {
        return Array.from(peerConnections.keys()).filter(peerId => {
            const pc = peerConnections.get(peerId);
            return pc && pc.connectionState === 'connected';
        });
    }

    function init(config = {}) {
        if (config.onStateChanged) callbacks.onStateChanged = config.onStateChanged;
        if (config.onPeersChanged) callbacks.onPeersChanged = config.onPeersChanged;
        if (config.onError) callbacks.onError = config.onError;

        const savedVolume = localStorage.getItem('voiceCallVolume');
        if (savedVolume) {
            masterVolume = parseFloat(savedVolume);
        }

        log('Voice call module initialized');
    }

    return {
        init,
        joinVoice,
        leaveVoice,
        toggleMute,
        setVolume,
        getVolume,
        isMuted: isMutedState,
        isConnected,
        getActivePeers
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VoiceCall;
}
