import React, { useState, useEffect } from "react";
import { signInWithGoogle } from "./firebase";

const App = () => {
  const [messages, setMessages] = useState([]);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    // Connetti al WebSocket server
    const socket = new WebSocket("ws://localhost:5000/ws");
    setWs(socket);

    // Gestisci i messaggi ricevuti
    socket.onmessage = (event) => {
      setMessages((prevMessages) => [...prevMessages, event.data]);
    };

    // Pulizia alla chiusura del componente
    return () => socket.close();
  }, []);

  const handleGoogleLogin = async () => {
    const user = await signInWithGoogle();
    console.log("Benvenuto:", user.displayName);
  };

  const sendMessage = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = "Ciao dal client!";
      ws.send(message);
    }
  };

  return (
    <div>
      <h1>Accedi con Google</h1>
      <button onClick={handleGoogleLogin}>Accedi con Google</button>

      <h2>Messaggi:</h2>
      <ul>
        {messages.map((msg, index) => (
          <li key={index}>{msg}</li>
        ))}
      </ul>

      <button onClick={sendMessage}>Invia messaggio al server</button>
    </div>
  );
};

export default App;
