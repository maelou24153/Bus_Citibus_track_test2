// server.js
// Serveur pour le suivi des bus Citibus (Grand Narbonne) : positions en temps
// réel (GTFS-RT), arrêts, tracés de lignes et horaires théoriques (GTFS statique).

const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
const PORT = process.env.PORT || 3000;

const GTFS_RT_URL = "https://feed-citibus-narbonne.ratpdev.com/GTFS-RT/gtfs-rt.bin";
const GTFS_STATIC_URL = "https://s3.eu-west-1.amazonaws.com/files.orchestra.ratpdev.com/networks/narbonne/exports/scolaires-sans-tad.zip";

app.use(express.json());
// index.html est à la racine du projet (à côté de server.js), pas dans un
// sous-dossier "public" séparé.
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Données statiques GTFS (arrêts, lignes, tracés, horaires théoriques)
// Rechargées périodiquement car le réseau les met à jour régulièrement.
// ---------------------------------------------------------------------------
let gtfsData = {
  stops: [],              // [{id, name, lat, lon}]
  routes: new Map(),      // routeId -> {id, shortName, longName, color}
  trips: new Map(),       // tripId -> {routeId, shapeId, serviceId, headsign, directionId}
  stopTimesByStop: new Map(), // stopId -> [{tripId, stopSequence, stopId, arrivalSec, departureSec}]
  stopTimesByTrip: new Map(), // tripId -> [{tripId, stopSequence, stopId, arrivalSec, departureSec}] (triés)
  stopNameById: new Map(), // stopId -> nom de l'arrêt
  shapesByRoute: new Map(),   // routeId -> [ [ [lat,lon], ... ], ... ]  (une ou plusieurs polylignes)
  calendar: new Map(),    // serviceId -> {days:[0..6], start, end}
  calendarDates: new Map(), // serviceId -> Map(dateStr -> exceptionType)
  stopRouteIds: new Map(), // stopId -> [routeId, ...] (lignes desservant cet arrêt)
};

// ---------------------------------------------------------------------------
// Avis voyageurs (petit questionnaire au clic sur un bus). Stocké en mémoire
// et associé au vehicleId (identifiant physique du véhicule GTFS-RT), qui
// reste stable d'un trajet à l'autre contrairement au tripId.
// ---------------------------------------------------------------------------
const FEEDBACK_KEYS = ["full", "heating", "ac", "driver", "driving"];
const feedbackStore = new Map(); // vehicleId -> { full:{yes,no}, heating:{yes,no}, ... }

function emptyFeedback() {
  const f = {};
  FEEDBACK_KEYS.forEach((k) => (f[k] = { yes: 0, no: 0 }));
  return f;
}

function timeToSeconds(hms) {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function readCsv(zip, filename) {
  const entry = zip.getEntries().find(
    (e) => e.entryName.toLowerCase().endsWith(filename)
  );
  if (!entry) return [];
  const content = entry.getData().toString("utf8").replace(/^\uFEFF/, "");
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

async function loadStaticGtfs() {
  console.log("Téléchargement des données GTFS statiques…");
  const response = await fetch(GTFS_STATIC_URL);
  if (!response.ok) throw new Error(`GTFS statique inaccessible (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);

  // --- Arrêts ---
  const stopsRows = readCsv(zip, "stops.txt");
  const stops = stopsRows
    .filter((r) => r.stop_lat && r.stop_lon)
    .map((r) => ({
      id: r.stop_id,
      name: r.stop_name,
      lat: parseFloat(r.stop_lat),
      lon: parseFloat(r.stop_lon),
    }));

  // --- Lignes ---
  const routes = new Map();
  readCsv(zip, "routes.txt").forEach((r) => {
    routes.set(r.route_id, {
      id: r.route_id,
      shortName: r.route_short_name || r.route_id,
      longName: r.route_long_name || "",
      color: r.route_color ? `#${r.route_color}` : "#e11d48",
    });
  });

  // --- Voyages (trips) ---
  const trips = new Map();
  readCsv(zip, "trips.txt").forEach((r) => {
    trips.set(r.trip_id, {
      routeId: r.route_id,
      shapeId: r.shape_id || null,
      serviceId: r.service_id,
      headsign: r.trip_headsign || "",
      directionId: r.direction_id || "0",
    });
  });

  // --- Horaires théoriques (stop_times) regroupés par arrêt et par voyage ---
  const stopTimesByStop = new Map();
  const stopTimesByTrip = new Map();
  const stopNameById = new Map();
  stops.forEach((s) => stopNameById.set(s.id, s.name));

  readCsv(zip, "stop_times.txt").forEach((r) => {
    if (!r.arrival_time) return;
    const entry = {
      tripId: r.trip_id,
      stopSequence: parseInt(r.stop_sequence, 10),
      stopId: r.stop_id,
      arrivalSec: timeToSeconds(r.arrival_time),
      departureSec: timeToSeconds(r.departure_time || r.arrival_time),
    };
    if (!stopTimesByStop.has(r.stop_id)) stopTimesByStop.set(r.stop_id, []);
    stopTimesByStop.get(r.stop_id).push(entry);

    if (!stopTimesByTrip.has(r.trip_id)) stopTimesByTrip.set(r.trip_id, []);
    stopTimesByTrip.get(r.trip_id).push(entry);
  });
  stopTimesByTrip.forEach((entries) => entries.sort((a, b) => a.stopSequence - b.stopSequence));

  // --- Calendrier de service ---
  const calendar = new Map();
  readCsv(zip, "calendar.txt").forEach((r) => {
    calendar.set(r.service_id, {
      days: [
        r.sunday, r.monday, r.tuesday, r.wednesday,
        r.thursday, r.friday, r.saturday,
      ].map((d) => d === "1"),
      start: r.start_date,
      end: r.end_date,
    });
  });

  const calendarDates = new Map();
  readCsv(zip, "calendar_dates.txt").forEach((r) => {
    if (!calendarDates.has(r.service_id)) calendarDates.set(r.service_id, new Map());
    calendarDates.get(r.service_id).set(r.date, r.exception_type);
  });

  // --- Tracés (shapes) regroupés par ligne ---
  const shapePoints = new Map(); // shapeId -> [{seq, lat, lon}]
  readCsv(zip, "shapes.txt").forEach((r) => {
    if (!shapePoints.has(r.shape_id)) shapePoints.set(r.shape_id, []);
    shapePoints.get(r.shape_id).push({
      seq: parseInt(r.shape_pt_sequence, 10),
      lat: parseFloat(r.shape_pt_lat),
      lon: parseFloat(r.shape_pt_lon),
    });
  });

  // shapeId -> routeId (via un trip qui l'utilise)
  const shapeToRoute = new Map();
  trips.forEach((t) => {
    if (t.shapeId && !shapeToRoute.has(t.shapeId)) shapeToRoute.set(t.shapeId, t.routeId);
  });

  const shapesByRoute = new Map();
  shapePoints.forEach((points, shapeId) => {
    const routeId = shapeToRoute.get(shapeId);
    if (!routeId) return;
    const sorted = points.sort((a, b) => a.seq - b.seq).map((p) => [p.lat, p.lon]);
    if (!shapesByRoute.has(routeId)) shapesByRoute.set(routeId, []);
    shapesByRoute.get(routeId).push({ shapeId, points: sorted });
  });

  // --- Lignes desservant chaque arrêt (pour le filtre "arrêts inutilisés") ---
  const stopRouteIds = new Map();
  stopTimesByStop.forEach((entries, stopId) => {
    const routeSet = new Set();
    entries.forEach((e) => {
      const trip = trips.get(e.tripId);
      if (trip) routeSet.add(trip.routeId);
    });
    stopRouteIds.set(stopId, [...routeSet]);
  });

  gtfsData = {
    stops, routes, trips, stopTimesByStop, stopTimesByTrip, stopNameById,
    shapesByRoute, calendar, calendarDates, stopRouteIds,
  };
  console.log(
    `GTFS statique chargé : ${stops.length} arrêts, ${routes.size} lignes, ${trips.size} voyages.`
  );
}

function isServiceActiveOn(serviceId, dateObj) {
  const dateStr =
    dateObj.getFullYear().toString() +
    String(dateObj.getMonth() + 1).padStart(2, "0") +
    String(dateObj.getDate()).padStart(2, "0");

  const exceptions = gtfsData.calendarDates.get(serviceId);
  if (exceptions && exceptions.has(dateStr)) {
    return exceptions.get(dateStr) === "1";
  }

  const cal = gtfsData.calendar.get(serviceId);
  if (!cal) return false;
  if (dateStr < cal.start || dateStr > cal.end) return false;
  return cal.days[dateObj.getDay()];
}

// ---------------------------------------------------------------------------
// Données temps réel (GTFS-RT), rafraîchies toutes les 5s et mises en cache
// pour être partagées entre les différents endpoints.
// ---------------------------------------------------------------------------
let realtimeCache = { vehicles: [], tripUpdatesByTrip: new Map(), updatedAt: 0 };

async function refreshRealtime() {
  try {
    const response = await fetch(GTFS_RT_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = [];
    const tripUpdatesByTrip = new Map();

    feed.entity.forEach((entity) => {
      if (entity.vehicle && entity.vehicle.position) {
        const v = entity.vehicle;
        const trip = v.trip?.tripId ? gtfsData.trips.get(v.trip.tripId) : null;
        const routeId = v.trip?.routeId || trip?.routeId || null;
        const route = routeId ? gtfsData.routes.get(routeId) : null;
        vehicles.push({
          id: v.vehicle?.id || entity.id,
          label: v.vehicle?.label || null,
          routeId,
          routeShortName: route?.shortName || routeId || "?",
          routeColor: route?.color || "#6b2c73",
          tripId: v.trip?.tripId || null,
          shapeId: trip?.shapeId || null,
          headsign: trip?.headsign || null,
          latitude: v.position.latitude,
          longitude: v.position.longitude,
          bearing: v.position.bearing ?? null,
          speed: v.position.speed ?? null,
          status: v.currentStatus || null,
          timestamp: v.timestamp ? Number(v.timestamp) : null,
        });
      }
      if (entity.tripUpdate) {
        const tu = entity.tripUpdate;
        tripUpdatesByTrip.set(tu.trip.tripId, tu.stopTimeUpdate || []);
      }
    });

    realtimeCache = { vehicles, tripUpdatesByTrip, updatedAt: Date.now() };
  } catch (err) {
    console.error("Erreur flux GTFS-RT :", err.message);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

app.get("/api/vehicles", (req, res) => {
  res.json({ vehicles: realtimeCache.vehicles, updatedAt: realtimeCache.updatedAt });
});

app.get("/api/stops", (req, res) => {
  const stops = gtfsData.stops.map((s) => ({
    ...s,
    routeIds: gtfsData.stopRouteIds.get(s.id) || [],
  }));
  res.json({ stops });
});

app.get("/api/shapes", (req, res) => {
  const result = [];
  gtfsData.shapesByRoute.forEach((shapes, routeId) => {
    const route = gtfsData.routes.get(routeId);
    result.push({
      routeId,
      shortName: route?.shortName || routeId,
      color: route?.color || "#e11d48",
      shapes, // [{shapeId, points: [[lat,lon], ...]}]
    });
  });
  res.json({ routes: result });
});

// Prochains passages théoriques + temps réel pour un arrêt donné
app.get("/api/stops/:stopId/next", (req, res) => {
  const stopId = req.params.stopId;
  const entries = gtfsData.stopTimesByStop.get(stopId) || [];
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  const results = [];
  for (const st of entries) {
    const trip = gtfsData.trips.get(st.tripId);
    if (!trip) continue;
    if (!isServiceActiveOn(trip.serviceId, now)) continue;

    // Ne garder que les passages dans les 90 prochaines minutes
    const diff = st.arrivalSec - nowSec;
    if (diff < -60 || diff > 90 * 60) continue;

    // Ajout du retard temps réel si disponible pour ce voyage
    let delaySec = 0;
    let realtime = false;
    const updates = realtimeCache.tripUpdatesByTrip.get(st.tripId);
    if (updates) {
      const match = updates.find((u) => u.stopSequence === st.stopSequence || u.stopId === st.stopId);
      if (match && match.arrival && typeof match.arrival.delay === "number") {
        delaySec = match.arrival.delay;
        realtime = true;
      }
    }

    const route = gtfsData.routes.get(trip.routeId);
    results.push({
      routeShortName: route?.shortName || trip.routeId,
      routeColor: route?.color || "#e11d48",
      headsign: trip.headsign,
      scheduledSec: st.arrivalSec,
      etaSec: st.arrivalSec + delaySec,
      realtime,
    });
  }

  results.sort((a, b) => a.etaSec - b.etaSec);
  res.json({ stopId, results: results.slice(0, 8) });
});

// Horaires en temps réel (prochains arrêts) du voyage actuellement effectué
// par un bus donné (au clic sur le bus).
app.get("/api/vehicles/:vehicleId/next", (req, res) => {
  const vehicleId = req.params.vehicleId;
  const vehicle = realtimeCache.vehicles.find((v) => String(v.id) === vehicleId);
  if (!vehicle || !vehicle.tripId) {
    return res.json({ vehicleId, results: [] });
  }

  const trip = gtfsData.trips.get(vehicle.tripId);
  const stopTimes = gtfsData.stopTimesByTrip.get(vehicle.tripId) || [];
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const updates = realtimeCache.tripUpdatesByTrip.get(vehicle.tripId);

  const results = [];
  for (const st of stopTimes) {
    if (st.arrivalSec < nowSec - 60) continue; // arrêts déjà passés

    let delaySec = 0;
    let realtime = false;
    if (updates) {
      const match = updates.find((u) => u.stopSequence === st.stopSequence || u.stopId === st.stopId);
      if (match && match.arrival && typeof match.arrival.delay === "number") {
        delaySec = match.arrival.delay;
        realtime = true;
      }
    }

    results.push({
      stopId: st.stopId,
      stopName: gtfsData.stopNameById.get(st.stopId) || st.stopId,
      scheduledSec: st.arrivalSec,
      etaSec: st.arrivalSec + delaySec,
      realtime,
    });
  }

  res.json({
    vehicleId,
    routeShortName: vehicle.routeShortName,
    routeColor: vehicle.routeColor,
    headsign: trip?.headsign || vehicle.headsign || "",
    results: results.slice(0, 8),
  });
});

// --- Petit questionnaire voyageur (avis en direct sur un bus) ---
app.post("/api/vehicles/:vehicleId/feedback", (req, res) => {
  const vehicleId = req.params.vehicleId;
  if (!feedbackStore.has(vehicleId)) feedbackStore.set(vehicleId, emptyFeedback());
  const f = feedbackStore.get(vehicleId);

  FEEDBACK_KEYS.forEach((key) => {
    const val = req.body ? req.body[key] : undefined;
    if (val === true) f[key].yes += 1;
    else if (val === false) f[key].no += 1;
  });

  res.json({ ok: true });
});

app.get("/api/vehicles/:vehicleId/feedback", (req, res) => {
  const vehicleId = req.params.vehicleId;
  const f = feedbackStore.get(vehicleId) || emptyFeedback();
  const summary = {};
  let totalVotes = 0;
  FEEDBACK_KEYS.forEach((key) => {
    const { yes, no } = f[key];
    const total = yes + no;
    totalVotes += total;
    summary[key] = { yes, no, total, pct: total > 0 ? Math.round((yes / total) * 100) : null };
  });
  res.json({ vehicleId, totalVotes, summary });
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function start() {
  try {
    await loadStaticGtfs();
  } catch (err) {
    console.error("Impossible de charger le GTFS statique au démarrage :", err.message);
  }
  await refreshRealtime();

  setInterval(refreshRealtime, 5 * 1000); // temps réel toutes les 5s
  setInterval(() => {
    loadStaticGtfs().catch((err) => console.error("Erreur rechargement GTFS statique :", err.message));
  }, 12 * 60 * 60 * 1000); // horaires théoriques toutes les 12h

  app.listen(PORT, (0.0.0.0) => {
    console.log(`Serveur bus-tracker démarré sur http://localhost:${PORT}`);
  });
}

start();
