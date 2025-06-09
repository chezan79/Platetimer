const crypto = require('crypto');

class AgoraTokenGenerator {
    constructor(appId, appCertificate) {
        this.appId = appId;
        this.appCertificate = appCertificate;
    }

    generateToken(channelName, uid, role = 1, expireTime = 3600) {
        if (!this.appCertificate) {
            console.warn('⚠️ Agora App Certificate not provided, returning simple token');
            return `temp_token_${Date.now()}`;
        }

        try {
            // Simple token generation - in production you'd use the official Agora SDK
            const timestamp = Math.floor(Date.now() / 1000);
            const expireTimestamp = timestamp + expireTime;

            const message = `${this.appId}${channelName}${uid}${expireTimestamp}`;
            const signature = crypto.createHmac('sha256', this.appCertificate)
                                   .update(message)
                                   .digest('hex');

            return `${timestamp}.${expireTimestamp}.${signature}`;
        } catch (error) {
            console.error('❌ Errore generazione token Agora:', error);
            return `fallback_token_${Date.now()}`;
        }
    }
}

module.exports = { AgoraTokenGenerator };