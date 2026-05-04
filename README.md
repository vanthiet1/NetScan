# NetScan - Local Network Discovery Tool

A modern, web-based tool to scan and detect all devices connected to the same local network (WiFi/LAN) as the host machine.

## Features
- **Network Scanning**: Detects IP addresses, MAC addresses, and device names.
- **Modern Dashboard**: Clean, responsive UI with premium dark mode aesthetics.
- **Search & Filter**: Quickly find devices by IP, name, or MAC address.
- **Real-time Highlights**: Newly detected devices are highlighted during scans.
- **Responsive Design**: Works seamlessly on desktop and tablets.

---

## Prerequisites
- **Node.js** (v14 or higher recommended)
- **npm** (comes with Node.js)

---

## Installation & Running

### 1. Setup Backend
Open a terminal in the `backend` folder:
```bash
cd backend
npm install
npm start
```
The backend server will run on `http://localhost:5000`.

### 2. Setup Frontend
Open a new terminal in the `frontend` folder:
```bash
cd frontend
npm install
npm run dev
```
The frontend application will run on `http://localhost:3000`.

---

## Technical Details
- **Backend**: Node.js, Express, `local-devices` (uses ARP scanning).
- **Frontend**: React, Vite, Framer Motion (animations), Lucide React (icons).
- **Security**: The tool only performs local network discovery using standard ARP protocols. No external scanning is performed.

---

## Troubleshooting
- **No devices found**: Ensure you have administrative/sudo privileges on some systems (though usually not required for ARP on Windows).
- **Backend Connection Error**: Ensure the backend is running on port 5000 and CORS is enabled (it is by default in this implementation).
- **MAC addresses missing**: On some mobile devices or restricted networks, MAC addresses might be hidden for privacy reasons.
