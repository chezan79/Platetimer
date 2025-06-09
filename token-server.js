
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
const crypto = require('crypto');

class AgoraTokenGenerator {
    constructor(appId, appCertificate) {
        this.appId = appId;
        this.appCertificate = appCertificate;
    }

    generateToken(channelName, uid, role = 1, expireTime = 3600) {
        if (!this.appCertificate) {
            // Se non c'è certificato, restituisce un token vuoto per test
            console.log('⚠️ Agora App Certificate non configurato, generazione token disabilitata');
            return null;
        }

        try {
            // Implementazione semplificata per generazione token Agora
            // In produzione dovresti usare la libreria ufficiale agora-access-token
            const timestamp = Math.floor(Date.now() / 1000);
            const privilegeExpiredTs = timestamp + expireTime;
            
            // Genera un token di base per test
            const tokenData = {
                appId: this.appId,
                channelName: channelName,
                uid: uid,
                role: role,
                expireTime: privilegeExpiredTs
            };

            // Token semplificato per test (in produzione usa la libreria ufficiale)
            const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
            
            console.log(`🔑 Token Agora generato per canale: ${channelName}, UID: ${uid}`);
            return token;
        } catch (error) {
            console.error('❌ Errore generazione token Agora:', error);
            return null;
        }
    }
}

module.exports = { AgoraTokenGenerator };
