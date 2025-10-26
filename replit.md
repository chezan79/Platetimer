# Restaurant Countdown Management System

## Overview

A real-time restaurant order coordination system that manages countdowns for dish preparation across different stations (Kitchen, Pizzeria, Salad Bar) and displays them to dining room staff. The application uses WebSocket-based real-time communication to synchronize timers across multiple viewing stations, enabling efficient coordination of multi-course meal preparation.

## Recent Changes

### October 26, 2025 - Countdown Launch Capability in Insalata (Salad Bar) Station
- **Enhanced insalata.html with countdown launcher** to enable salad bar staff to initiate countdowns
  - Added left-side control container matching cucina.html layout pattern
  - Virtual numeric keyboard for table number input (0-9 + Clear)
  - Multi-select destination buttons (Cucina, Pizzeria, Insalata) with visual feedback
  - Duration selection grid (4, 5, 6, 7, 8, 9, 10, 12, 15 minutes)
  - Smart UI: duration buttons enabled only after selecting at least one destination
  
- **Implemented JavaScript countdown management logic**
  - `sendCountdown()`: Sends WebSocket `startCountdown` message for each selected destination
  - `resetCountdownSelection()`: Clears selections and resets UI state after countdown launch
  - `showCountdownConfirmation()`: Displays animated success message with countdown details
  - `updateDestinationCountdownFeedback()`: Updates section title to show selected destinations
  - Separate state management (`selectedDestinationsCountdown`) to avoid conflicts with voice message destinations
  
- **Consistent user experience across stations**
  - Insalata.html now has parity with cucina.html for countdown launching
  - Same visual design language, layout structure, and interaction patterns
  - Countdown messages broadcast to all selected destinations via WebSocket
  - Recipients (cucina, pizzeria, insalata, sala) receive and display countdowns based on their destination filters

### October 7, 2025 - WebRTC Group Voice Call Feature
- **Implemented WebRTC-based group audio call system** for inter-department communication
  - Mesh P2P topology allowing Kitchen, Pizzeria, and Salad Bar to communicate via real-time audio
  - WebSocket signaling for offer/answer/ICE candidate exchange
  - Support for TURN/STUN servers for NAT traversal (configurable via environment variables)
  - Automatic reconnection logic with exponential backoff
  - Mute/unmute controls and volume adjustment per user
  - Real-time peer connection status and participant count display
  
- **Created voice-call.js module** (`public/js/voice-call.js`)
  - Manages local media streams (microphone access)
  - Handles peer-to-peer connections using RTCPeerConnection API
  - Implements connection state management and cleanup
  - Remote audio element creation and management
  - Graceful error handling for permission denials and connection failures
  
- **Added voice call UI to all station pages**
  - Floating voice panel with minimal footprint (bottom corners)
  - Toggle button (🎙️) to show/hide panel without disrupting workflow
  - Join/leave call functionality with clear status indicators
  - Mute button and volume slider for audio control
  - Live participant counter showing active callers
  - Color-coded status: green (connected), red (error), gray (disconnected)
  
- **Enhanced server.js with WebRTC signaling**
  - New WebSocket actions: `voice_join`, `voice_offer`, `voice_answer`, `voice_ice_candidate`, `voice_leave`, `voice_mute`
  - Room-based signaling ensures only same-company participants can communicate
  - Broadcast mechanism for peer discovery and connection establishment
  - Tracks active voice participants per room for cleanup

### October 7, 2025 - Sala (Dining Room) Monitoring Enhancement
- **Added comprehensive sala.html page** for dining room staff to monitor all active countdowns
  - Real-time countdown display with automatic updates via WebSocket
  - Advanced filtering by station (Kitchen/Pizzeria/Salad) and table search
  - Color-coded alerts: neutral (>5min), warning (2-5min), critical (<2min with pulse animation)
  - Live statistics: active countdown count, average wait time, tables in waiting
  - Mobile-first responsive design with large fonts for tablet viewing
  - Connection status indicator with automatic reconnection
  
- **Created shared JavaScript module** (`public/js/countdowns.js`)
  - Reusable functions: `subscribeCountdowns`, `fetchActiveCountdowns`, `formatTime`, `groupByTable`
  - WebSocket connection management with heartbeat and automatic reconnection
  - Alert level calculation and statistics computation
  - Can be used across all station pages for consistent behavior
  
- **Added REST API endpoint** (`GET /api/countdowns`)
  - Query parameters: `status` (default: 'active'), `company` (optional)
  - Server-side time calculation to prevent drift
  - Returns countdown data with remaining time, destinations, start time, etc.
  - Fallback mechanism for when WebSocket is unavailable
  
- **Created maintenance documentation** (README-MAINTENANCE.md)
  - Complete API documentation and WebSocket event schema
  - Extension points for adding new stations and features
  - Troubleshooting guide and maintenance tasks

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Multi-page Static Application**: The system uses traditional HTML pages served statically rather than a single-page application framework. Each station has its own dedicated view:
- `cucina.html` - Kitchen station for initiating countdowns
- `pizzeria.html` - Pizzeria station view
- `insalata.html` - Salad bar station view  
- `sala.html` - Dining room staff monitoring view
- `home.html` - Navigation hub

**Client-side State Management**: Uses vanilla JavaScript with localStorage for user session persistence (company name, authentication tokens). No state management library is employed.

**Real-time Updates**: WebSocket client connections established in each view to receive countdown updates. Fallback polling mechanism available via REST API (`/api/countdowns`) for network resilience.

**UI Framework**: Pure CSS with custom gradients and transitions. No CSS framework dependencies. Responsive design implemented through custom media queries.

### Backend Architecture

**Web Server**: Express.js application serving static files and providing REST endpoints. Single-server deployment pattern running on port 5000.

**WebSocket Server**: Uses `ws` library integrated with the HTTP server. Single WebSocket path (`/ws`) handles all real-time bidirectional communication for countdown synchronization across all stations.

**Message Broadcasting Pattern**: When kitchen initiates a countdown, the server broadcasts the countdown data to all connected WebSocket clients, ensuring synchronized display across pizzeria, salad, and dining room views.

**Maintenance Mode**: Toggle-based system-wide maintenance mode that redirects all traffic to `maintenance.html` except for static assets. Controlled via `MAINTENANCE_MODE` flag in `server.js`.

### Data Storage Solutions

**Firebase Firestore**: Primary database for persistent storage of:
- User accounts and authentication data
- Company/restaurant information
- Countdown history and logs
- Active countdown state (for recovery after server restart)

**Collection Structure**:
- `/users/{userId}` - User profile data including company affiliation
- `/countdowns/{companyId}/{countdownId}` - Company-scoped countdown records
- `/public/{document}` - Publicly readable data

**Security Rules**: Authentication-required for all countdown operations. Users can only access their own user document. Company-scoped data isolation implemented through Firestore security rules.

**In-Memory State**: Active countdowns maintained in server memory for performance. WebSocket connections tracked in memory for broadcast targeting.

### Authentication & Authorization

**Firebase Authentication**: Email/password authentication with optional Google OAuth integration. Password reset flow implemented with Firebase action handlers.

**Session Management**: Firebase auth tokens stored in browser localStorage. Token refresh handled automatically by Firebase SDK.

**Multi-tenancy**: Company-based data isolation where each restaurant/company has separate countdown namespaces. Company name stored in user profile and used to filter countdown queries.

**Authorization Model**: 
- Authenticated users can read/write countdowns for their company
- Company affiliation stored in Firestore user document
- Client-side company filtering via localStorage `userCompany` key

### API Design

**REST Endpoints**:
- `GET /api/countdowns?status=active&company={name}` - Fetch filtered countdowns
- Static file serving for all HTML/CSS/JS assets

**WebSocket Messages**:
- Client → Server: `{ action: 'startCountdown', tableNumber, timeRemaining }`
- Server → All Clients: Broadcast countdown updates with table number and remaining time
- Heartbeat mechanism for connection health monitoring
- **WebRTC Signaling Messages**:
  - `voice_join`: Notify peers of new participant entering voice call
  - `voice_offer`: Send WebRTC offer to establish peer connection
  - `voice_answer`: Respond to offer to complete connection setup
  - `voice_ice_candidate`: Exchange ICE candidates for NAT traversal
  - `voice_leave`: Notify peers of participant leaving call
  - `voice_mute`: Broadcast mute/unmute status to other participants

**Response Format**: Standard JSON structure with `{ success: boolean, countdowns: [], error?: string }`

## External Dependencies

### Cloud Services

**Firebase Platform** (v11.8.1):
- **Firebase Authentication**: User authentication, password reset, email verification
- **Cloud Firestore**: NoSQL document database for persistent data storage
- **Firebase Hosting**: (Implied for production deployment based on auth domain)
- **Project ID**: `app-dati-tavoli`
- **Service Account**: Google Cloud service account for server-side Firebase admin operations

**Google Cloud Speech API** (v7.1.0):
- Voice recognition integration for hands-free countdown initiation in kitchen
- Requires `GOOGLE_APPLICATION_CREDENTIALS_JSON` environment variable
- Service account credentials provided via JSON key file

### Payment Processing

**Stripe** (v18.2.1): 
- Payment gateway integration (subscription.html reference suggests subscription billing model)
- Usage pattern suggests recurring subscription payments for restaurant accounts

### Third-party Libraries

**Express.js** (v4.18.2): HTTP server framework and static file serving

**WebSocket (ws)** (v8.13.0): WebSocket server implementation for real-time communication

### Development Tools

**Drizzle ORM Configuration**: Backend contains `drizzle.config.json` suggesting PostgreSQL schema management, though not currently integrated. Configuration points to PostgreSQL dialect with schema definition in TypeScript.

### Security Considerations

**API Keys**: Firebase configuration contains public API key (client-side usage is acceptable per Firebase documentation)

**Service Account**: Private key stored in attached assets for Google Cloud Speech API (should be moved to environment variables in production)

**Firestore Rules**: Authentication required for all write operations; company-scoped read/write access enforced at database level