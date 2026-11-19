import { collaborators } from "./PartnerUniversities";
import styles from "./collaboration-map.module.css";
import world from "@/public/data/maps/world_110m.json";

const width = 1000;
const height = 430;

function project(longitude: number, latitude: number) {
  return [(longitude + 180) / 360 * width, (82 - latitude) / 140 * height] as const;
}

// Decode the local TopoJSON once on the server, before the page reaches the browser.
const projectedArcs = world.arcs.map(arc => {
  let longitude = 0;
  let latitude = 0;
  return arc.map(([deltaLongitude, deltaLatitude]) => {
    longitude += deltaLongitude;
    latitude += deltaLatitude;
    return project(
      longitude * world.transform.scale[0] + world.transform.translate[0],
      latitude * world.transform.scale[1] + world.transform.translate[1],
    );
  });
});

function ringPath(arcs: number[]) {
  const points = arcs.flatMap(index => {
    const arc = projectedArcs[index < 0 ? ~index : index];
    return index < 0 ? [...arc].reverse() : arc;
  });
  if (points.length === 0) return "";

  // Unwrap rings at the date line and repeat edge fragments instead of crossing the map.
  let previousX = points[0][0];
  const unwrapped = points.map(([x, y]) => {
    const wrappedX = x + Math.round((previousX - x) / width) * width;
    previousX = wrappedX;
    return [wrappedX, y] as const;
  });
  const offsets = [0];
  if (unwrapped.some(([x]) => x < 0)) offsets.push(width);
  if (unwrapped.some(([x]) => x > width)) offsets.push(-width);
  return offsets.map(offset => unwrapped.map(([x, y], index) => (
    `${index === 0 ? "M" : "L"}${(x + offset).toFixed(1)},${y.toFixed(1)}`
  )).join("") + "Z").join("");
}

const countries = world.objects.countries.geometries
  .filter(country => country.id !== "ATA")
  .map((country, index) => {
    const polygons = country.type === "Polygon"
      ? [country.arcs as number[][]]
      : country.arcs as number[][][];
    return { id: country.id ?? `region-${index}`, path: polygons.flatMap(polygon => polygon.map(ringPath)).join("") };
  });

// Illustration baselines are deliberately offset from campus locations, especially on the US coasts.
const landmarks = {
  ucsd: { label: "UC San Diego", building: "Geisel Library", x: 106, y: 251 },
  stanford: { label: "Stanford", building: "Hoover Tower", x: 108, y: 91 },
  cmu: { label: "Carnegie Mellon", building: "Hamerschlag Hall", x: 289, y: 238 },
  mit: { label: "MIT", building: "Great Dome", x: 321, y: 85 },
  unil: { label: "UNIL", building: "Palais de Rumine, a historic university building", x: 532, y: 84 },
  hku: { label: "HKU", building: "Main Building", x: 775, y: 269 },
  irides: { label: "Tohoku · IRIDeS", building: "IRIDeS Building", x: 908, y: 105 },
};

const campuses = collaborators.map(partner => {
  const [pinX, pinY] = project(partner.lon, partner.lat);
  return { ...partner, ...landmarks[partner.id], pinX, pinY };
});

export default function CollaborationMap() {
  return (
    <div className="mt-6 w-full">
      <figure className={styles.atlas} role="img" aria-labelledby="collaboration-map-title"
        aria-describedby="collaboration-map-description">
        <figcaption className="sr-only">
          <span id="collaboration-map-title">World map of HumanStudy-Hub partnerships</span>
          <span id="collaboration-map-description">
            {campuses.map(campus => `${campus.name}, ${campus.city} — ${campus.building}.`).join(" ")}
          </span>
        </figcaption>
        <svg width="0" height="0" className={styles.definitions} aria-hidden="true">
          <defs>
            <pattern id="atlas-water" width="9" height="9" patternUnits="userSpaceOnUse">
              <rect width="9" height="9" fill="#f4f6f0" />
              <path d="m1 7 1.1-.25m4-4 .8-.2" stroke="#9bb5a9" strokeOpacity=".28" strokeWidth=".7" />
            </pattern>
            <pattern id="atlas-land" width="5" height="5" patternUnits="userSpaceOnUse">
              <rect width="5" height="5" fill="#dce5cd" />
              <path d="m0 5 5-5" stroke="#a6b59a" strokeWidth=".5" strokeOpacity=".39" />
            </pattern>
            <pattern id="atlas-graticule" width={width / 12} height={height * 30 / 140} x="0"
              y={project(0, 60)[1]} patternUnits="userSpaceOnUse">
              <path d={`M0 ${height * 30 / 140}V0H${width / 12}`} fill="none" stroke="#829a90"
                strokeWidth=".7" strokeDasharray="2 4" />
            </pattern>
            <g id="atlas-geography">
              <rect width={width} height={height} fill="url(#atlas-water)" />
              <g fill="url(#atlas-land)" stroke="#adbea7" strokeWidth=".55" fillRule="evenodd">
                {countries.map(country => <path key={country.id} d={country.path} />)}
              </g>
              <rect width={width} height={height} fill="url(#atlas-graticule)" />
              <g className={styles.sea}>
                <text x="145" y="353">Pacific Ocean</text>
                <text x="398" y="265">Atlantic Ocean</text>
                <text x="704" y="366">Indian Ocean</text>
              </g>
              <g className={styles.compass} transform="translate(46 337)" fill="#597469" stroke="#597469" strokeWidth=".8">
                <text y="-25" stroke="none" textAnchor="middle" className={styles.north}>N</text>
                <path d="M0-19 4-2 13 0 3 3 0 18-3 3-13 0-4-2Z" fill="#f4f6f0" />
                <path d="M0-19V0L-4-2ZM0 0 3 3 0 18Z" />
              </g>
            </g>
            <g id="atlas-campuses">
              {campuses.map(({ id, label, building, name, pinX, pinY, x, y }) => {
                const edgeY = y < pinY ? y + 18 : y - 67;
                return (
                  <g key={id} data-campus={id}>
                    <title>{`${name} — ${building}`}</title>
                    <path d={`M${pinX},${pinY} Q${pinX},${(pinY + edgeY) / 2} ${x},${edgeY}`}
                      fill="none" stroke="#667d6b" strokeWidth="1.3" strokeDasharray="2 2.4" strokeLinecap="round" />
                    <circle cx={pinX} cy={pinY} r="3" fill="#315c4c" stroke="#fafaf1" strokeWidth="1.1" />
                    <image href={`/images/campuses/${id}.webp`} x={x - 50} y={y - 72} width="100" height="72"
                      preserveAspectRatio="xMidYMax meet" className={styles.building} />
                    <text x={x} y={y + 14} className={styles.campusLabel}>{label}</text>
                  </g>
                );
              })}
            </g>
            <g id="atlas-composition">
              <use href="#atlas-geography" /><use href="#atlas-campuses" />
            </g>
          </defs>
        </svg>
        <svg viewBox={`0 0 ${width} ${height}`} className={styles.world} aria-hidden="true">
          <use href="#atlas-composition" />
        </svg>
        <div className={styles.regions} aria-hidden="true">
          {["24 0 387 279", "383 0 387 176", "641 12 359 291"].map(viewBox => (
            <svg key={viewBox} viewBox={viewBox}><use href="#atlas-composition" /></svg>
          ))}
        </div>
      </figure>
    </div>
  );
}
