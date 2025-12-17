
# 🎥 StreamFlow: Educational Video Data Aggregator

![Node.js](https://img.shields.io/badge/Node.js-Production-green?style=for-the-badge&logo=node.js)
![Express.js](https://img.shields.io/badge/Express.js-Backend-white?style=for-the-badge&logo=express)
![Status](https://img.shields.io/badge/Status-Live-blue?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)

> **Live Demo:** [https://youtube-i.onrender.com](https://youtube-i.onrender.com)

---

## 📖 Overview

**StreamFlow** is a high-performance video data aggregation engine designed to study the efficiency of **Reverse-Engineered APIs** and **Decoupled System Architecture**. 

Unlike traditional YouTube clones that rely on the official Data API (which has strict quota limits), StreamFlow leverages the open-source `youtubei.js` library to scrape, parse, and structure internal YouTube data (InnerTube API) in real-time. This project demonstrates advanced backend logic, including complex JSON parsing, modular API design, and asynchronous data streaming.

---

## 🏗️ System Architecture

The application follows a strict **MVC (Model-View-Controller)** pattern but separates the API logic completely from the view layer to simulate a microservices-like environment.

### 🔄 Data Flow Pipeline
1.  **Client Request:** User searches for a video or plays a URL.
2.  **API Gateway (Express):** Route handlers intercept the request.
3.  **Data Aggregation Engine:** The backend utilizes `youtubei.js` to fetch raw metadata from YouTube's internal endpoints.
4.  **Parsing Logic:** Complex nested JSON objects (Comments, Related Videos, Channel Metadata) are cleaned and structured.
5.  **Response:** Optimized JSON data is sent to the frontend.
6.  **Playback:** The official **YouTube Embed API** is used for the actual video stream to respect content delivery policies.

---

## 🚀 Key Features

* **⚡ Rate-Limit Free Architecture:** By using `youtubei.js` instead of the official API, the system bypasses standard quota limitations for educational research purposes.
* **🛠️ Modular Backend Structure:** Codebase is strictly organized into `Handlers`, `Routes`, and `Public` directories for maintainability.
* **🧩 Complex Data Parsing:** accurately extracts and structures deep-nested data like:
    * Video Metadata (Views, Likes, Date)
    * Channel Information (@Handle, Subscribers)
    * Recursive Comments Threads
    * Related Video Algorithms
* **🔌 Decoupled Frontend:** The frontend uses **Vanilla JavaScript** to consume the backend APIs asynchronously, demonstrating pure DOM manipulation skills without heavy frameworks.
* **📱 Responsive UI:** Mobile-first design generated with AI-assisted prototyping tools, fine-tuned for performance.

---

## 🛠️ Tech Stack

### Backend
* **Runtime:** Node.js
* **Framework:** Express.js
* **Core Library:** `youtubei.js` (InnerTube Client)
* **Architecture:** RESTful API

### Frontend
* **Core:** HTML5, CSS3, Vanilla JavaScript (ES6+)
* **Integration:** YouTube IFrame Player API
* **Deployment:** Render (Cloud Hosting)

---

## 📂 Project Structure

```bash
streamflow-youtube-i/
│
├── 📂 public/           # Static assets (CSS, Client-side JS, Images)
│   ├── css/
│   ├── js/
│   └── index.html
│
├── 📂 src/
│   ├── 📂 routes/       # API Route Definitions
│   │   ├── search.route.js
│   │   └── video.route.js
│   │
│   ├── 📂 handlers/     # Core Business Logic & Scraping Functions
│   │   ├── search.handler.js
│   │   └── video.handler.js
│   │
│   └── 📂 utils/        # Helper functions (Error handling, formatting)
│
├── index.js             # Entry point & Server Configuration
├── package.json         # Dependencies
└── README.md            # Documentation

```

---

## 🔧 Installation & Setup

To run this project locally, follow these steps:

1. **Clone the repository:**
```bash
git clone [https://github.com/shivamnox/youtube-i.git](https://github.com/shivamnox/youtube-i.git)
cd youtube-i

```


2. **Install Dependencies:**
```bash
npm install

```


3. **Start the Server:**
```bash
npm start

```


*The server will start on `http://localhost:3000*`

---

## 📡 API Endpoints

The backend exposes the following RESTful endpoints:

### 1. Search Videos

* **Endpoint:** `GET /search`
* **Query Params:** `?q=query_string`
* **Description:** Returns a list of videos matching the search query.

### 2. Get Video Details

* **Endpoint:** `GET /video`
* **Query Params:** `?id=video_id`
* **Description:** Returns full metadata, comments, and related videos for a specific ID.

---

## ⚠️ Disclaimer & Legal

This project is developed strictly for **educational purposes** to understand web scraping, API reverse-engineering, and data structuring.

* **No Commercial Use:** This project is not intended for commercial exploitation.
* **Content Rights:** All video content is streamed via the official YouTube Embed API. We do not host or download any video files.
* **Terms of Service:** This project explores the `youtubei.js` library capabilities. Users should be aware of YouTube's Terms of Service regarding data scraping.

---

## 👨‍💻 Author

**Shivam Kumar**

* **Role:** Backend Engineer
* **Portfolio:** [GitHub](https://github.com/shivamnox)
* **Email:** shivamnox@gmail.com

---

### ⭐️ Show your support

If you find this project interesting, please give it a ⭐️ on GitHub!
