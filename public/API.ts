
// API.ts - Gestione centralizzata delle chiamate API per il sistema vocale

interface AgoraConfig {
    agoraAppId: string;
    agoraToken: string | null;
}

interface VoiceMessageRequest {
    audioData: string;
    messageId: string;
    destination: 'cucina' | 'pizzeria' | 'insalata';
    from?: string;
}

interface VoiceMessageResponse {
    success: boolean;
    messageId: string;
    destination: string;
}

interface SpeechToTextRequest {
    audioData: string;
    config?: {
        encoding?: string;
        sampleRateHertz?: number;
        languageCode?: string;
        model?: string;
        useEnhanced?: boolean;
    };
}

interface SpeechToTextResponse {
    transcription: string;
    confidence: number;
}

interface ApiError {
    error: string;
    details?: string;
}

class CallAPI {
    private baseUrl: string;

    constructor() {
        this.baseUrl = window.location.origin;
    }

    /**
     * Ottiene la configurazione Agora dal server
     */
    async getAgoraConfig(): Promise<AgoraConfig> {
        try {
            const response = await fetch(`${this.baseUrl}/api/config`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const config = await response.json();
            console.log('✅ Configurazione Agora caricata:', config);
            
            return config;
        } catch (error) {
            console.error('❌ Errore caricamento configurazione Agora:', error);
            throw new Error(`Errore nel caricamento della configurazione: ${error.message}`);
        }
    }

    /**
     * Invia un messaggio vocale al server
     */
    async sendVoiceMessage(request: VoiceMessageRequest): Promise<VoiceMessageResponse> {
        try {
            const response = await fetch(`${this.baseUrl}/api/voice-message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(request)
            });

            if (!response.ok) {
                const errorData: ApiError = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }

            const result: VoiceMessageResponse = await response.json();
            console.log('✅ Messaggio vocale inviato:', result);
            
            return result;
        } catch (error) {
            console.error('❌ Errore invio messaggio vocale:', error);
            throw new Error(`Errore nell'invio del messaggio vocale: ${error.message}`);
        }
    }

    /**
     * Converte audio in testo usando Google Speech-to-Text
     */
    async speechToText(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
        try {
            const response = await fetch(`${this.baseUrl}/api/speech-to-text`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(request)
            });

            if (!response.ok) {
                const errorData: ApiError = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }

            const result: SpeechToTextResponse = await response.json();
            console.log('✅ Trascrizione completata:', result.transcription);
            
            return result;
        } catch (error) {
            console.error('❌ Errore trascrizione audio:', error);
            throw new Error(`Errore nella trascrizione: ${error.message}`);
        }
    }

    /**
     * Testa la connessione al server
     */
    async testConnection(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/config`);
            return response.ok;
        } catch (error) {
            console.error('❌ Test connessione fallito:', error);
            return false;
        }
    }

    /**
     * Utility per convertire Blob audio in base64
     */
    async blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                // Rimuovi il prefisso "data:audio/webm;base64," se presente
                const base64 = result.split(',')[1] || result;
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Utility per generare ID univoci per i messaggi
     */
    generateMessageId(): string {
        return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Valida i dati prima di inviarli al server
     */
    validateVoiceMessage(request: VoiceMessageRequest): boolean {
        if (!request.audioData || typeof request.audioData !== 'string') {
            console.error('❌ Audio data mancante o non valido');
            return false;
        }

        if (!request.messageId || typeof request.messageId !== 'string') {
            console.error('❌ Message ID mancante o non valido');
            return false;
        }

        const validDestinations = ['cucina', 'pizzeria', 'insalata'];
        if (!request.destination || !validDestinations.includes(request.destination)) {
            console.error('❌ Destinazione non valida:', request.destination);
            return false;
        }

        return true;
    }

    /**
     * Gestisce gli errori API in modo standardizzato
     */
    handleApiError(error: any, context: string): void {
        console.error(`❌ Errore API [${context}]:`, error);
        
        // Qui potresti aggiungere logging centralizzato, notifiche utente, etc.
        if (error.message?.includes('network') || error.message?.includes('fetch')) {
            console.warn('⚠️ Problema di connessione rilevato');
        }
    }
}

// Crea un'istanza singleton dell'API
const callAPI = new CallAPI();

// Esporta l'istanza per l'uso globale
window.callAPI = callAPI;

// Esporta anche le interfacce per TypeScript
export type {
    AgoraConfig,
    VoiceMessageRequest,
    VoiceMessageResponse,
    SpeechToTextRequest,
    SpeechToTextResponse,
    ApiError
};

export default callAPI;

// Per compatibilità con JavaScript vanilla
if (typeof module !== 'undefined' && module.exports) {
    module.exports = callAPI;
}

console.log('✅ API.ts caricato - Sistema chiamate API inizializzato');
