const PLAYER_SEARCH_FIELDS = [
  "name",
  "fullName",
  "displayName",
  "shortName",
  "commonName",
  "playerName",
  "teamName",
  "nationality",
  "position",
];

const FOOTBALL_ALIASES = [
{ match: "lionel messi", aliases: ["messi", "leo messi", "leo"] },
{ match: "cristiano ronaldo", aliases: ["cr7", "ronaldo", "cristiano"] },
{ match: "neymar", aliases: ["neymar jr", "ney"] },

{ match: "kylian mbappe", aliases: ["mbappe"] },
{ match: "kylian mbappe lottin", aliases: ["mbappe", "kylian mbappe"] },

{ match: "erling haaland", aliases: ["haaland"] },
{ match: "kevin de bruyne", aliases: ["kdb", "de bruyne"] },
{ match: "mohamed salah", aliases: ["salah", "mo salah"] },
{ match: "sadio mane", aliases: ["mane"] },
{ match: "victor osimhen", aliases: ["osimhen"] },

{ match: "vinicius", aliases: ["vini", "vini jr", "vinicius junior"] },
{
match: "vinicius jose paixao de oliveira junior",
aliases: ["vini", "vini jr", "vinicius junior", "vinicius"],
},
{ match: "rodrygo", aliases: ["rodrygo goes"] },
{ match: "rodrygo silva de goes", aliases: ["rodrygo", "rodrygo goes"] },
{ match: "jude bellingham", aliases: ["bellingham", "jude"] },
{ match: "luka modric", aliases: ["modric"] },
{ match: "toni kroos", aliases: ["kroos"] },
{ match: "federico valverde", aliases: ["valverde", "fede valverde"] },
{ match: "thibaut courtois", aliases: ["courtois"] },

{ match: "pedro gonzalez lopez", aliases: ["pedri"] },
{ match: "pedri", aliases: ["pedro gonzalez lopez"] },
{ match: "pablo martin paez gavira", aliases: ["gavi"] },
{ match: "gavi", aliases: ["pablo martin paez gavira"] },
{ match: "rodrigo hernandez cascante", aliases: ["rodri"] },
{ match: "rodri", aliases: ["rodrigo hernandez cascante"] },
{ match: "lamine yamal", aliases: ["yamal", "lamine"] },
{ match: "lamine yamal nasraoui ebana", aliases: ["lamine yamal", "yamal"] },
{ match: "nico williams", aliases: ["nicolas williams", "niko williams"] },
{ match: "daniel olmo", aliases: ["dani olmo"] },
{ match: "dani olmo", aliases: ["daniel olmo"] },
{ match: "ferran torres garcia", aliases: ["ferran torres"] },
{ match: "ferran torres", aliases: ["ferran"] },
{ match: "marc cucurella", aliases: ["cucurella"] },
{ match: "mikel merino", aliases: ["merino"] },

{ match: "raphinha", aliases: ["rafinha", "raphinia", "rapinha"] },
{
match: "raphael dias belloli",
aliases: ["raphinha", "rafinha", "raphinia", "rapinha"],
},
{ match: "alisson becker", aliases: ["alisson"] },
{ match: "ederson", aliases: ["ederson moraes"] },
{ match: "ederson santana de moraes", aliases: ["ederson"] },
{ match: "marquinhos", aliases: ["marcos aoas correa"] },
{ match: "marcos aoas correa", aliases: ["marquinhos"] },
{ match: "casemiro", aliases: ["carlos henrique casimiro"] },
{ match: "carlos henrique casimiro", aliases: ["casemiro"] },
{ match: "lucas paqueta", aliases: ["paqueta"] },
{ match: "richarlison", aliases: ["richarlison de andrade"] },
{ match: "gabriel martinelli", aliases: ["martinelli"] },
{ match: "gabriel jesus", aliases: ["jesus"] },

{ match: "harry kane", aliases: ["kane"] },
{ match: "phil foden", aliases: ["foden"] },
{ match: "bukayo saka", aliases: ["saka"] },
{ match: "cole palmer", aliases: ["palmer"] },
{ match: "declan rice", aliases: ["rice"] },
{ match: "trent alexander arnold", aliases: ["trent", "taa"] },
{ match: "jack grealish", aliases: ["grealish"] },
{ match: "marcus rashford", aliases: ["rashford"] },

{ match: "antoine griezmann", aliases: ["griezmann"] },
{ match: "ousmane dembele", aliases: ["dembele"] },
{ match: "aurelien tchouameni", aliases: ["tchouameni"] },
{ match: "eduardo camavinga", aliases: ["camavinga"] },
{ match: "william saliba", aliases: ["saliba"] },
{ match: "jules kounde", aliases: ["kounde"] },
{ match: "olivier giroud", aliases: ["giroud"] },
{ match: "mike maignan", aliases: ["maignan"] },

{ match: "jamal musiala", aliases: ["musiala"] },
{ match: "florian wirtz", aliases: ["wirtz"] },
{ match: "kai havertz", aliases: ["havertz"] },
{ match: "leroy sane", aliases: ["sane"] },
{ match: "ilkay gundogan", aliases: ["gundogan"] },
{ match: "manuel neuer", aliases: ["neuer"] },

{ match: "lautaro martinez", aliases: ["lautaro"] },
{ match: "julian alvarez", aliases: ["julian", "alvarez"] },
{ match: "emiliano martinez", aliases: ["emi martinez", "dibu", "dibu martinez"] },
{ match: "enzo fernandez", aliases: ["enzo"] },
{ match: "alexis mac allister", aliases: ["mac allister", "macallister"] },
{ match: "paulo dybala", aliases: ["dybala"] },

{ match: "luis suarez", aliases: ["suarez"] },
{ match: "darwin nunez", aliases: ["darwin", "nunez"] },
{ match: "ronald araujo", aliases: ["araujo"] },
{ match: "manuel ugarte", aliases: ["ugarte"] },

{ match: "bruno fernandes", aliases: ["bruno"] },
{ match: "bernardo silva", aliases: ["bernardo"] },
{ match: "joao felix", aliases: ["felix"] },
{ match: "joao cancelo", aliases: ["cancelo"] },
{ match: "ruben dias", aliases: ["dias"] },
{ match: "diogo costa", aliases: ["costa"] },

{ match: "robert lewandowski", aliases: ["lewandowski", "lewa"] },
{ match: "lewandowski", aliases: ["lewa", "robert lewandowski"] },
{ match: "piotr zielinski", aliases: ["zielinski"] },

{ match: "memphis depay", aliases: ["memphis", "depay"] },
{ match: "virgil van dijk", aliases: ["van dijk", "vvd"] },
{ match: "frenkie de jong", aliases: ["de jong", "frenkie"] },
{ match: "xavi simons", aliases: ["simons"] },
{ match: "cody gakpo", aliases: ["gakpo"] },

{ match: "christian pulisic", aliases: ["pulisic", "captain america"] },
{ match: "gio reyna", aliases: ["reyna", "giovanni reyna"] },
{ match: "giovanni reyna", aliases: ["gio reyna", "reyna"] },
{ match: "weston mckennie", aliases: ["mckennie"] },
{ match: "yunus musah", aliases: ["musah"] },
{ match: "folarin balogun", aliases: ["balogun"] },
{ match: "timothy weah", aliases: ["tim weah", "weah"] },

{ match: "hirving lozano", aliases: ["chucky", "chucky lozano", "lozano"] },
{ match: "guillermo ochoa", aliases: ["memo ochoa", "ochoa", "memo"] },
{ match: "raul jimenez", aliases: ["jimenez"] },
{ match: "santiago gimenez", aliases: ["santi gimenez", "gimenez"] },
{ match: "edson alvarez", aliases: ["edson"] },

{ match: "alphonso davies", aliases: ["davies"] },
{ match: "jonathan david", aliases: ["david"] },
{ match: "tajon buchanan", aliases: ["buchanan"] },

{ match: "heung min son", aliases: ["son", "son heung min", "hm son"] },
{ match: "son heung min", aliases: ["son", "heung min son", "hm son"] },
{ match: "kim min jae", aliases: ["kim min-jae", "min jae kim"] },

{ match: "kaoru mitoma", aliases: ["mitoma"] },
{ match: "takefusa kubo", aliases: ["kubo"] },
{ match: "wataru endo", aliases: ["endo"] },

{ match: "achraf hakimi", aliases: ["hakimi"] },
{ match: "hakim ziyech", aliases: ["ziyech"] },
{ match: "yassine bounou", aliases: ["bounou", "bono"] },
{ match: "youssef en nesyri", aliases: ["en nesyri", "ennesyri"] },

{ match: "luis diaz", aliases: ["lucho diaz", "lucho"] },
{ match: "james rodriguez", aliases: ["james"] },

{ match: "khvicha kvaratskhelia", aliases: ["kvara", "kvaradona"] },
{ match: "gianluigi donnarumma", aliases: ["donnarumma", "gigi donnarumma"] },
{ match: "nicolo barella", aliases: ["barella"] },
{ match: "federico chiesa", aliases: ["chiesa"] },
{ match: "rafael leao", aliases: ["rafa leao", "leao"] },
{ match: "sergej milinkovic savic", aliases: ["sms", "milinkovic savic"] },
{ match: "aleksandar mitrovic", aliases: ["mitrovic"] },
{ match: "dusan vlahovic", aliases: ["vlahovic"] },
];


export function normalizeSearchText(value) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((token) => (token === "jr" ? "junior" : token))
    .join(" ");
}

function generatedNameAliases(value) {
  const tokens = normalizeSearchText(value).split(" ").filter(Boolean);
  if (tokens.length < 2) return [];

  const first = tokens[0];
  const finalToken = tokens[tokens.length - 1];
  return [`${first} ${finalToken}`];
}

function manualFootballAliases(searchableText) {
  const normalizedText = normalizeSearchText(searchableText);
  const aliases = [];

  for (const entry of FOOTBALL_ALIASES) {
    if (normalizedText.includes(normalizeSearchText(entry.match))) {
      aliases.push(...entry.aliases);
    }
  }

  return aliases;
}

function isWithinEditDistance(left, right, maxDistance) {
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  if (left === right) return true;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = current[0];

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
      rowMinimum = Math.min(rowMinimum, current[j]);
    }

    if (rowMinimum > maxDistance) return false;
    previous = current;
  }

  return previous[right.length] <= maxDistance;
}

function tokenMatches(searchableText, searchableTokens, queryToken) {
  if (searchableText.includes(queryToken)) return true;
  if (queryToken.length < 5) return false;

  const maxDistance = queryToken.length >= 8 ? 2 : 1;
  return searchableTokens.some((candidate) => {
    if (candidate.length < 4) return false;
    return isWithinEditDistance(queryToken, candidate, maxDistance);
  });
}

export function buildPlayerSearchText(player = {}) {
  const values = PLAYER_SEARCH_FIELDS.flatMap((field) => {
    const value = player?.[field];
    return Array.isArray(value) ? value : [value];
  });

  values.push(
    player?.player?.name,
    player?.player?.fullName,
    player?.player?.displayName,
    player?.player?.shortName,
    player?.player?.commonName,
    player?.team?.name,
    player?.club,
    player?.clubName,
    player?.realTeamName,
    player?.country,
    player?.nation,
    player?.countryName,
    player?.pos
  );

  if (Array.isArray(player?.aliases)) {
    values.push(...player.aliases);
  }

  const nameValues = [
    player?.name,
    player?.fullName,
    player?.displayName,
    player?.shortName,
    player?.commonName,
    player?.playerName,
    player?.player?.name,
    player?.player?.fullName,
    player?.player?.displayName,
    player?.player?.shortName,
    player?.player?.commonName,
  ].filter(Boolean);

  for (const name of nameValues) {
    values.push(...generatedNameAliases(name));
  }

  values.push(...manualFootballAliases(values.filter(Boolean).join(" ")));

  return normalizeSearchText(values.filter(Boolean).join(" "));
}

export function matchesNormalizedSearch(searchableText, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const normalizedSearchableText = normalizeSearchText(searchableText);
  const searchableTokens = normalizedSearchableText.split(" ").filter(Boolean);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);

  return queryTokens.every((token) =>
    tokenMatches(normalizedSearchableText, searchableTokens, token)
  );
}

export function matchesPlayerSearch(player, query) {
  return matchesNormalizedSearch(buildPlayerSearchText(player), query);
}
