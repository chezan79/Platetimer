# 🍽️ Restaurant Countdown Management System - Maintenance Guide

## 📋 Overview

This is a real-time restaurant order coordination system that manages countdowns for dish preparation across different stations (Kitchen, Pizzeria, Salad Bar) and displays them to the dining room staff.

## 🚀 How to Run the Project

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn package manager

### Installation & Startup

1. **Install dependencies** (if not already installed):
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   node server.js
   ```

3. **Access the application**:
   - Server runs on: `http://0.0.0.0:5000`
   - Kitchen page: `/cucina.html`
   - Pizzeria page: `/pizzeria.html`
   - Salad page: `/insalata.html`
   - Dining room (Sala) page: `/sala.html`

## 📡 Available Endpoints

### REST API

#### GET `/api/countdowns`
Returns all active countdowns.

**Query Parameters:**
- `status` (optional): Filter by status. Default: `'active'`
- `company` (optional): Filter by company name

**Response:**
```json
{
  "success": true,
  "countdowns": [
    {
      "tableNumber": "12",
      "remainingTime": 300,
      "initialDuration": 600,
      "destinations": ["pizzeria", "cucina"],
      "startedAt": "14:30",
      "startTime": 1696684200000,
      "endsAt": 1696684800000,
      "status": "active"
    }
  ],
  "count": 1,
  "timestamp": 1696684500000
}
```

#### POST `/api/voice-message`
Saves voice messages for station communication.

**Request Body:**
```json
{
  "audioData": "base64_encoded_audio",
  "messageId": "unique_id",
  "destination": "pizzeria",
  "from": "cucina"
}
```

#### POST `/api/speech-to-text`
Converts audio to text using Google Cloud Speech API.

**Request Body:**
```json
{
  "audioData": "base64_encoded_audio",
  "config": {
    "encoding": "WEBM_OPUS",
    "sampleRateHertz": 48000,
    "languageCode": "it-IT"
  }
}
```

### WebSocket Endpoint

**Path:** `/ws`

The WebSocket server handles real-time communication for countdowns, voice messages, and status updates.

## 📨 WebSocket Event Schema

### Client → Server Messages

#### Join Room
```json
{
  "action": "joinRoom",
  "companyName": "Restaurant Name"
}
```

#### Join Page
```json
{
  "action": "joinPage",
  "pageType": "cucina" | "pizzeria" | "insalata" | "sala"
}
```

#### Start Countdown
```json
{
  "action": "startCountdown",
  "tableNumber": "12",
  "timeRemaining": 600,
  "destination": "pizzeria"
}
```

#### Delete Countdown
```json
{
  "action": "deleteCountdown",
  "tableNumber": "12"
}
```

#### Voice Message
```json
{
  "action": "voiceMessage",
  "message": "Pizza ready for table 5",
  "messageId": "unique_id",
  "destination": "pizzeria",
  "from": "cucina",
  "audioData": "base64_audio",
  "hasAudio": true
}
```

#### Pause Station
```json
{
  "action": "pausaCucina" | "pausaPizzeria" | "pausaInsalata",
  "durataMinuti": 10,
  "messageId": "unique_id",
  "from": "station_name"
}
```

### Server → Client Messages

#### Countdown Update
```json
{
  "action": "startCountdown",
  "tableNumber": "12",
  "timeRemaining": 600,
  "destination": "pizzeria"
}
```

#### Countdown Deleted
```json
{
  "action": "deleteCountdown",
  "tableNumber": "12"
}
```

#### Connection Confirmed
```json
{
  "action": "connectionConfirmed",
  "message": "Connected successfully"
}
```

#### Heartbeat (Ping/Pong)
```json
{
  "action": "ping",
  "timestamp": 1696684500000
}
```

## 🛠️ Extension Points

### Adding New Station Types

1. **Update server validation** in `server.js`:
   ```javascript
   const validDestinations = ['cucina', 'pizzeria', 'insalata', 'new_station'];
   ```

2. **Create new HTML page** following the pattern in `pizzeria.html` or `insalata.html`

3. **Add filter button** in `sala.html`:
   ```html
   <button class="filter-btn" data-filter="new_station">🔧 New Station</button>
   ```

### Adding New Alert Levels

Modify the `getAlertLevel()` function in `public/js/countdowns.js`:

```javascript
function getAlertLevel(remainingSeconds) {
    if (remainingSeconds < 60) {
        return 'urgent';  // New level
    } else if (remainingSeconds < 120) {
        return 'critical';
    } else if (remainingSeconds < 300) {
        return 'warning';
    } else {
        return 'neutral';
    }
}
```

Then add corresponding CSS styles in `sala.html`.

### Adding Custom Statistics

Add new calculation functions in `public/js/countdowns.js`:

```javascript
function calculateCustomStat(countdowns) {
    // Your custom logic here
    return result;
}
```

Then expose in the module's return object:

```javascript
return {
    subscribeCountdowns,
    fetchActiveCountdowns,
    formatTime,
    groupByTable,
    getAlertLevel,
    calculateAverageWaitTime,
    calculateCustomStat  // New function
};
```

### Customizing Countdown Behavior

The countdown data structure in server memory:

```javascript
{
    startTime: Date.now(),
    initialDuration: 600,  // seconds
    tableNumber: "12",
    destinations: ["pizzeria", "cucina"]
}
```

Stored in: `activeCountdowns` Map with structure:
- Key: `companyName` → Map
  - Key: `tableNumber` → countdown object

### Adding Filters in Sala Page

1. Add filter button in the HTML
2. Update the filter logic in `renderCountdowns()`:
   ```javascript
   const matchesFilter = activeFilter === 'all' || 
       customFilterLogic(countdown, activeFilter);
   ```

## 🔧 Maintenance Tasks

### Cleaning Up Expired Countdowns

The server automatically cleans up expired countdowns every 5 minutes. See `server.js` line ~920:

```javascript
setInterval(() => {
    activeCountdowns.forEach((companyCountdowns, companyName) => {
        // Cleanup logic
    });
}, 300000);
```

### Monitoring WebSocket Health

Each page implements:
- **Heartbeat**: 15-second pong messages
- **Reconnection**: Automatic reconnect on disconnect with 3-second interval
- **Connection status**: Visual indicator at bottom-right

### Database Integration (Future)

Currently uses in-memory storage (`Map` objects). To add persistence:

1. Replace `activeCountdowns` Map with database queries
2. Add database initialization in startup
3. Update countdown storage logic in WebSocket handlers
4. Maintain backward compatibility with event schema

## 🐛 Troubleshooting

### Countdowns not showing in Sala page
- Check browser console for WebSocket connection errors
- Verify `localStorage.getItem('userCompany')` matches the company in server
- Confirm countdowns have the correct destination in their array

### WebSocket disconnections
- Check server logs for rate limiting messages
- Verify network stability
- Check browser console for reconnection attempts

### Time drift issues
- Sala page calculates time from server's `startTime` and `initialDuration`
- Ensures accurate display even after page reload
- Uses `Date.now()` consistently on server side

## 📝 Notes

- **Rate Limiting**: Max 10 WebSocket messages per client per minute
- **Maintenance Mode**: Set `MAINTENANCE_MODE = true` in `server.js` to enable
- **Audio Alerts**: Triggered at 60 seconds remaining and at zero
- **Company Rooms**: Each company has isolated countdown data
- **Page Types**: cucina, pizzeria, insalata, sala (each syncs relevant countdowns)
