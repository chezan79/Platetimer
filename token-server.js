
const crypto = require('crypto');

// Temporary token generation for Agora
// This is a simplified version for development purposes
class AgoraTokenGenerator {
  constructor(appId, appCertificate) {
    this.appId = appId;
    this.appCertificate = appCertificate;
  }

  generateToken(channelName, uid, role = 1, expireTime = 3600) {
    // For development purposes, we'll use a simple approach
    // In production, use the official Agora token server
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expireTime;
    
    // Create a simple hash-based token for testing
    const data = `${this.appId}${channelName}${uid}${privilegeExpiredTs}`;
    const token = crypto.createHmac('sha256', this.appCertificate || 'test-certificate')
                       .update(data)
                       .digest('hex');
    
    return `006${token.substring(0, 32)}`;
  }
}

module.exports = { AgoraTokenGenerator };
