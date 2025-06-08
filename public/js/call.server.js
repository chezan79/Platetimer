const express = require('express');
const { voiceCallAPI } = require('./api');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Initialize user when they access a page
app.post('/api/init-user', async (req, res) => {
  try {
    const { username, displayName } = req.body;
    const user = await voiceCallAPI.initializeUser(username, displayName);
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start a call
app.post('/api/start-call', async (req, res) => {
  try {
    const { callerUsername, receiverUsername, channelName } = req.body;
    const result = await voiceCallAPI.startCall(callerUsername, receiverUsername, channelName);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Accept a call
app.post('/api/accept-call', async (req, res) => {
  try {
    const { channelName } = req.body;
    const activeCall = await voiceCallAPI.acceptCall(channelName);
    res.json({ success: true, activeCall });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// End a call
app.post('/api/end-call', async (req, res) => {
  try {
    const { channelName, duration } = req.body;
    await voiceCallAPI.endCall(channelName, duration);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get call history
app.get('/api/call-history/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { limit = 10 } = req.query;
    const history = await voiceCallAPI.getCallHistory(username, parseInt(limit));
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get active calls for user
app.get('/api/active-calls/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const activeCalls = await voiceCallAPI.getActiveCallsForUser(username);
    res.json({ success: true, activeCalls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice call server running on port ${PORT}`);
});

module.exports = app;