import { promises as fs } from 'fs';
import path from 'path';
import LeaderboardList from './LeaderboardList';

export default async function LeaderboardTable() {
  const filePath = path.join(process.cwd(), 'data/leaderboard.json');
  let data = [];
  try {
      const fileContents = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(fileContents);
  } catch (e) {
      console.error("Could not read leaderboard data", e);
  }

  return (
    <div id="leaderboard" className="border-t border-gray-200 bg-gray-50 py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <div className="mb-10 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
                <div>
                    <p className="text-xs font-bold uppercase text-cyan-800">Initial test suite</p>
                    <h2 className="mt-2 font-serif text-3xl font-bold text-gray-900">Leaderboard</h2>
                    <p className="mt-3 text-sm leading-6 text-gray-600">Agent alignment across 12 reconstructed human-subject studies.</p>
                </div>
                <dl className="grid border-y border-gray-300 sm:grid-cols-2">
                    <div className="border-b border-gray-300 py-5 sm:border-b-0 sm:border-r sm:pr-6">
                        <dt className="text-sm font-bold text-gray-900"><span className="mr-2 font-mono text-cyan-800">PAS</span>Probability Alignment Score</dt>
                        <dd className="mt-2 text-xs leading-5 text-gray-600">Measures whether agents and humans reach the same scientific conclusion at the inferential level.</dd>
                    </div>
                    <div className="py-5 sm:pl-6">
                        <dt className="text-sm font-bold text-gray-900"><span className="mr-2 font-mono text-cyan-800">ECS</span>Effect Consistency Score</dt>
                        <dd className="mt-2 text-xs leading-5 text-gray-600">Measures how closely the magnitude and direction of agent effects match human ground truth.</dd>
                    </div>
                </dl>
            </div>

            <LeaderboardList rawData={data} />
        </div>
    </div>
  );
}
