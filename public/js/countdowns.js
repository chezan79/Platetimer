const CountdownsModule = (() => {
    let ws = null;
    let reconnectInterval = null;
    let heartbeatInterval = null;
    let isConnected = false;
    let onCountdownUpdateCallback = null;
    let onCountdownDeleteCallback = null;
    let onConnectionStatusCallback = null;

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    function groupByTable(countdowns) {
        const grouped = {};
        
        countdowns.forEach(countdown => {
            const tableKey = countdown.tableNumber;
            if (!grouped[tableKey]) {
                grouped[tableKey] = [];
            }
            grouped[tableKey].push(countdown);
        });
        
        return grouped;
    }

    function fetchActiveCountdowns(companyName) {
        const url = companyName 
            ? `/api/countdowns?status=active&company=${encodeURIComponent(companyName)}`
            : '/api/countdowns?status=active';
        
        return fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    return data.countdowns.map(countdown => ({
                        ...countdown,
                        remainingTimeFormatted: formatTime(countdown.remainingTime)
                    }));
                } else {
                    throw new Error(data.error || 'Failed to fetch countdowns');
                }
            })
            .catch(error => {
                console.error('Error fetching countdowns:', error);
                return [];
            });
    }

    function subscribeCountdowns(config) {
        const {
            companyName,
            onCountdownUpdate,
            onCountdownDelete,
            onConnectionStatus,
            reconnectDelay = 3000
        } = config;

        onCountdownUpdateCallback = onCountdownUpdate;
        onCountdownDeleteCallback = onCountdownDelete;
        onConnectionStatusCallback = onConnectionStatus;

        function connectWebSocket() {
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

                ws.onopen = () => {
                    console.log('🔗 Countdowns WebSocket connected');
                    isConnected = true;

                    if (reconnectInterval) {
                        clearInterval(reconnectInterval);
                        reconnectInterval = null;
                    }

                    startHeartbeat();

                    if (companyName) {
                        ws.send(JSON.stringify({
                            action: 'joinRoom',
                            companyName: companyName
                        }));
                        console.log(`✅ Joined room: ${companyName}`);
                    }

                    if (onConnectionStatusCallback) {
                        onConnectionStatusCallback(true);
                    }
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);

                        if (data.action === 'ping') {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
                            }
                            return;
                        }

                        if (data.action === 'startCountdown' && onCountdownUpdateCallback) {
                            onCountdownUpdateCallback({
                                tableNumber: data.tableNumber,
                                timeRemaining: data.timeRemaining,
                                destination: data.destination,
                                remainingTimeFormatted: formatTime(data.timeRemaining)
                            });
                        } else if (data.action === 'deleteCountdown' && onCountdownDeleteCallback) {
                            onCountdownDeleteCallback(data.tableNumber);
                        }
                    } catch (error) {
                        console.error('Error parsing WebSocket message:', error);
                    }
                };

                ws.onclose = (event) => {
                    console.log(`🔌 WebSocket disconnected: ${event.code}`);
                    isConnected = false;
                    stopHeartbeat();

                    if (onConnectionStatusCallback) {
                        onConnectionStatusCallback(false);
                    }

                    if (!reconnectInterval) {
                        console.log('🔄 Starting reconnection...');
                        reconnectInterval = setInterval(() => {
                            console.log('🔄 Attempting to reconnect...');
                            connectWebSocket();
                        }, reconnectDelay);
                    }
                };

                ws.onerror = (error) => {
                    console.error('❌ WebSocket error:', error);
                };

            } catch (error) {
                console.error('❌ Error creating WebSocket:', error);
                isConnected = false;
                if (onConnectionStatusCallback) {
                    onConnectionStatusCallback(false);
                }
            }
        }

        function startHeartbeat() {
            heartbeatInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
                } else if (ws && ws.readyState !== WebSocket.CONNECTING) {
                    console.log('🔄 Connection lost during heartbeat, reconnecting...');
                    connectWebSocket();
                }
            }, 15000);
        }

        function stopHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
        }

        connectWebSocket();

        return {
            disconnect: () => {
                if (ws) {
                    ws.close();
                }
                stopHeartbeat();
                if (reconnectInterval) {
                    clearInterval(reconnectInterval);
                }
            },
            isConnected: () => isConnected
        };
    }

    function getAlertLevel(remainingSeconds) {
        if (remainingSeconds < 120) {
            return 'critical';
        } else if (remainingSeconds < 300) {
            return 'warning';
        } else {
            return 'neutral';
        }
    }

    function calculateAverageWaitTime(countdowns) {
        if (countdowns.length === 0) return 0;
        
        const totalTime = countdowns.reduce((sum, countdown) => {
            return sum + countdown.remainingTime;
        }, 0);
        
        return Math.floor(totalTime / countdowns.length);
    }

    return {
        subscribeCountdowns,
        fetchActiveCountdowns,
        formatTime,
        groupByTable,
        getAlertLevel,
        calculateAverageWaitTime,
        getWebSocket: () => ws
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CountdownsModule;
}
