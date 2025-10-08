import React, { useState, useEffect } from "react";
import { signInWithGoogle } from "./firebase";

const App = () => {
  const [messages, setMessages] = useState([]);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    // Costruisci l'URL WS in base allo schema della pagina
    const WS_PROTO = window.location.protocol === "https:" ? "wss:" : "ws:";
    const WS_URL = `${WS_PROTO}//${window.location.host}/ws`;

    const socket = new WebSocket(WS_URL);
    setWs(socket);

    socket.onmessage = (event) => {
      setMessages((prev) => [...prev, event.data]);
    };

    // opzionale: log utili
    socket.onopen = () => console.log("WS connected:", WS_URL);
    socket.onclose = () => console.log("WS closed");
    socket.onerror = (e) => console.error("WS error:", e);

    return () => socket.close();
  }, []);

  const handleGoogleLogin = async () => {
    const user = await signInWithGoogle();
    console.log("Benvenuto:", user.displayName);
  };

  const sendMessage = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send("Ciao dal client!");
    }
  };

  return (
    <div>
      <h1>Accedi con Google</h1>
      <button onClick={handleGoogleLogin}>Accedi con Google</button>

      <h2>Messaggi:</h2>
      <ul>
        {messages.map((msg, i) => (
          <li key={i}>{msg}</li>
        ))}
      </ul>

      <button onClick={sendMessage}>Invia messaggio al server</button>
    </div>
  );
};

export default App;
