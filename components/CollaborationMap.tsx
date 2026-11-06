import world from "@/public/data/maps/world_110m.json";

const collaborators = [
  { name: "University of California San Diego", city: "San Diego, United States", lat: 32.8801, lon: -117.234 },
  { name: "University of Lausanne", city: "Lausanne, Switzerland", lat: 46.5197, lon: 6.6323 },
  { name: "Carnegie Mellon University", city: "Pittsburgh, United States", lat: 40.4433, lon: -79.9436 },
  { name: "The University of Hong Kong", city: "Hong Kong", lat: 22.283, lon: 114.1371 },
  { name: "IRIDeS, Tohoku University", city: "Sendai, Japan", lat: 38.2506, lon: 140.856 },
  { name: "Stanford University", city: "Stanford, United States", lat: 37.4275, lon: -122.1697 },
  { name: "Massachusetts Institute of Technology", city: "Cambridge, United States", lat: 42.3601, lon: -71.0942 },
];

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

const partners = collaborators.map(partner => {
  const [x, y] = project(partner.lon, partner.lat);
  return { ...partner, x, y };
});
const hub = partners[0];

export default function CollaborationMap() {
  return (
    <div className="mt-6 w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby="collaboration-map-title"
        aria-describedby="collaboration-map-description"
        className="block h-auto w-full overflow-hidden"
      >
        <title id="collaboration-map-title">World map of HumanStudy-Hub partnerships</title>
        <desc id="collaboration-map-description">Research partners in the United States, Switzerland, Hong Kong and Japan. The full list is available below the map.</desc>
        <g fill="var(--site-surface-deep)" stroke="var(--background)" strokeWidth="0.7" fillRule="evenodd">
          {countries.map(country => <path key={country.id} d={country.path} />)}
        </g>
        <g fill="none" stroke="var(--site-accent)" strokeOpacity="0.3">
          {partners.slice(1).map(partner => (
            <line key={partner.name} x1={hub.x} y1={hub.y} x2={partner.x} y2={partner.y} />
          ))}
        </g>
        {partners.map((partner, index) => (
          <circle
            key={partner.name}
            cx={partner.x}
            cy={partner.y}
            r={index === 0 ? 7.5 : 5.5}
            fill={index === 0 ? "var(--site-accent)" : "#72956a"}
            stroke="var(--background)"
            strokeWidth="2"
          >
            <title>{`${partner.name} — ${partner.city}`}</title>
          </circle>
        ))}
      </svg>
      <details className="mt-5 border-t border-[var(--site-line)] pt-4">
        <summary className="w-fit cursor-pointer py-2 text-sm text-[var(--site-accent)]">View research partners</summary>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {partners.map(partner => (
            <li key={partner.name}>
              <p>{partner.name}</p>
              <p className="mt-1 text-sm text-[var(--site-muted)]">{partner.city}</p>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
