const PLAYER_SEARCH_FIELDS = [
  "name",
  "fullName",
  "displayName",
  "shortName",
  "commonName",
  "playerName",
  "id",
  "playerId",
  "apiPlayerId",
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

{ match: "alphonso davies", aliases: ["davies", "phonzie"] },
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

// --- EXTRA ARGENTINA ---
{ match: "giovani lo celso", aliases: ["lo celso"] },
{ match: "leandro paredes", aliases: ["paredes"] },
{ match: "nicolas tagliafico", aliases: ["tagliafico"] },
{ match: "marcos acuna", aliases: ["acuna", "huevo acuna"] },
{ match: "nicolas otamendi", aliases: ["otamendi"] },
{ match: "gonzalo montiel", aliases: ["montiel"] },
{ match: "geronimo rulli", aliases: ["rulli"] },

// --- EXTRA BRAZIL ---
{ match: "endrick", aliases: ["endrick felipe", "endrick felipe moreira de sousa"] },
{ match: "estevao", aliases: ["estevao willian", "messinho"] },
{ match: "savinho", aliases: ["savio", "savio moreira"] },
{ match: "gabriel magalhaes", aliases: ["gabriel", "magalhaes", "gabriel dos santos magalhaes"] },
{ match: "danilo", aliases: ["danilo luiz", "danilo luiz da silva"] },
{ match: "joao gomes", aliases: ["joao gomes"] },
{ match: "andreas pereira", aliases: ["andreas"] },
{ match: "lucas beraldo", aliases: ["beraldo"] },
{ match: "yan couto", aliases: ["yan couto"] },

// --- EXTRA SPAIN ---
{ match: "martin zubimendi", aliases: ["zubimendi"] },
{ match: "fabian ruiz", aliases: ["fabian ruiz", "fabian"] },
{ match: "robin le normand", aliases: ["le normand"] },
{ match: "dani carvajal", aliases: ["daniel carvajal", "carvajal"] },
{ match: "david raya", aliases: ["raya"] },
{ match: "alex baena", aliases: ["baena", "alejandro baena"] },
{ match: "mikel oyarzabal", aliases: ["oyarzabal"] },
{ match: "joselu", aliases: ["jose luis sanmartin", "joselu mato"] },

// --- EXTRA ENGLAND ---
{ match: "eberechi eze", aliases: ["eze"] },
{ match: "jarrod bowen", aliases: ["bowen"] },
{ match: "conor gallagher", aliases: ["gallagher"] },
{ match: "marc guehi", aliases: ["guehi"] },
{ match: "ben white", aliases: ["white"] },
{ match: "reece james", aliases: ["reece", "james"] },
{ match: "james maddison", aliases: ["maddison"] },
{ match: "jarrad branthwaite", aliases: ["branthwaite"] },
{ match: "adam wharton", aliases: ["wharton"] },
{ match: "noni madueke", aliases: ["madueke"] },

// --- EXTRA FRANCE ---
{ match: "bradley barcola", aliases: ["barcola"] },
{ match: "marcus thuram", aliases: ["thuram"] },
{ match: "randal kolo muani", aliases: ["kolo muani"] },
{ match: "adrien rabiot", aliases: ["rabiot"] },
{ match: "dayot upamecano", aliases: ["upamecano"] },
{ match: "ibrahima konate", aliases: ["konate"] },
{ match: "warren zaire emery", aliases: ["zaire emery", "wze"] },
{ match: "benjamin pavard", aliases: ["pavard"] },
{ match: "ferland mendy", aliases: ["mendy"] },
{ match: "hugo ekitike", aliases: ["ekitike"] },

// --- EXTRA GERMANY ---
{ match: "marc andre ter stegen", aliases: ["ter stegen", "mats"] },
{ match: "serge gnabry", aliases: ["gnabry"] },
{ match: "leon goretzka", aliases: ["goretzka"] },
{ match: "karim adeyemi", aliases: ["adeyemi"] },
{ match: "angelo stiller", aliases: ["stiller"] },
{ match: "alexander nubel", aliases: ["nubel"] },
{ match: "waldemar anton", aliases: ["anton"] },
{ match: "emre can", aliases: ["can"] },
{ match: "benjamin henrichs", aliases: ["henrichs"] },
{ match: "maximilian beier", aliases: ["beier"] },

// --- EXTRA PORTUGAL ---
{ match: "goncalo ramos", aliases: ["ramos"] },
{ match: "joao neves", aliases: ["neves"] },
{ match: "francisco conceicao", aliases: ["conceicao", "chico conceicao"] },
{ match: "antonio silva", aliases: ["antonio"] },
{ match: "goncalo inacio", aliases: ["inacio"] },
{ match: "pedro neto", aliases: ["neto"] },
{ match: "nelson semedo", aliases: ["semedo"] },
{ match: "joao palhinha", aliases: ["palhinha"] },
{ match: "renato sanches", aliases: ["renato"] },

// --- EXTRA NETHERLANDS ---
{ match: "tijjani reijnders", aliases: ["reijnders"] },
{ match: "teun koopmeiners", aliases: ["koopmeiners"] },
{ match: "ryan gravenberch", aliases: ["gravenberch"] },
{ match: "donyell malen", aliases: ["malen"] },
{ match: "brian brobbey", aliases: ["brobbey"] },
{ match: "bart verbruggen", aliases: ["verbruggen"] },
{ match: "micky van de ven", aliases: ["van de ven"] },
{ match: "wout weghorst", aliases: ["weghorst"] },
{ match: "georginio wijnaldum", aliases: ["wijnaldum", "gini"] },

// --- EXTRA ITALY ---
{ match: "sandro tonali", aliases: ["tonali"] },
{ match: "davide frattesi", aliases: ["frattesi"] },
{ match: "riccardo calafiori", aliases: ["calafiori"] },
{ match: "matteo darmian", aliases: ["darmian"] },
{ match: "jorginho", aliases: ["jorge luiz frello"] },
{ match: "gianluca scamacca", aliases: ["scamacca"] },
{ match: "mateo retegui", aliases: ["retegui"] },
{ match: "manuel locatelli", aliases: ["locatelli"] },
{ match: "giacomo raspadori", aliases: ["raspadori"] },
{ match: "lorenzo pellegrini", aliases: ["pellegrini"] },

// --- EXTRA USA ---
{ match: "sergino dest", aliases: ["dest"] },
{ match: "ricardo pepi", aliases: ["pepi"] },
{ match: "josh sargent", aliases: ["sargent"] },
{ match: "brenden aaronson", aliases: ["aaronson"] },
{ match: "malik tillman", aliases: ["tillman"] },
{ match: "johnny cardoso", aliases: ["johnny", "cardoso"] },
{ match: "chris richards", aliases: ["christopher richards", "richards"] },
{ match: "matt turner", aliases: ["turner"] },
{ match: "joe scally", aliases: ["scally"] },
{ match: "cameron carter vickers", aliases: ["carter vickers", "ccv"] },

// --- EXTRA MEXICO ---
{ match: "luis malagon", aliases: ["malagon"] },
{ match: "cesar montes", aliases: ["montes"] },
{ match: "johan vasquez", aliases: ["vasquez"] },
{ match: "luis chavez", aliases: ["chavez"] },
{ match: "orbelin pineda", aliases: ["pineda"] },
{ match: "urias antuna", aliases: ["uriel antuna", "antuna"] },
{ match: "henry martin", aliases: ["martin"] },
{ match: "julian quinones", aliases: ["quinones"] },
{ match: "alexis vega", aliases: ["vega"] },
{ match: "roberto alvarado", aliases: ["piojo", "piojo alvarado", "alvarado"] },

// --- EXTRA CANADA ---
{ match: "stephen eustaquio", aliases: ["eustaquio"] },
{ match: "cyle larin", aliases: ["larin"] },
{ match: "israel reyes", aliases: ["reyes"] },
{ match: "moise bombito", aliases: ["bombito"] },
{ match: "jacob shaffelburg", aliases: ["shaffelburg"] },
{ match: "ismael kone", aliases: ["kone"] },
{ match: "maxime crepeau", aliases: ["crepeau"] },
{ match: "alistair johnston", aliases: ["johnston"] },
{ match: "sam adekugbe", aliases: ["adekugbe"] },

// --- EXTRA CROATIA / BELGIUM / SWITZERLAND ---
{ match: "josko gvardiol", aliases: ["gvardiol"] },
{ match: "mateo kovacic", aliases: ["kovacic"] },
{ match: "marcelo brozovic", aliases: ["brozovic"] },
{ match: "dominik livakovic", aliases: ["livakovic"] },
{ match: "lovro majer", aliases: ["majer"] },
{ match: "romelu lukaku", aliases: ["lukaku"] },
{ match: "jeremy doku", aliases: ["doku"] },
{ match: "leandro trossard", aliases: ["trossard"] },
{ match: "youri tielemans", aliases: ["tielemans"] },
{ match: "amadou onana", aliases: ["onana"] },
{ match: "charles de ketelaere", aliases: ["de ketelaere", "cdk"] },
{ match: "xherdan shaqiri", aliases: ["shaqiri"] },
{ match: "breel embolo", aliases: ["embolo"] },
{ match: "remo freuler", aliases: ["freuler"] },

// --- EXTRA MOROCCO / JAPAN / KOREA ---
{ match: "sofyan amrabat", aliases: ["amrabat"] },
{ match: "noussair mazraoui", aliases: ["mazraoui"] },
{ match: "brahim diaz", aliases: ["brahim", "brahim diaz"] },
{ match: "azzedine ounahi", aliases: ["ounahi"] },
{ match: "soufiane rahimi", aliases: ["rahimi"] },
{ match: "takumi minamino", aliases: ["minamino"] },
{ match: "ritsu doan", aliases: ["doan"] },
{ match: "daichi kamada", aliases: ["kamada"] },
{ match: "ayase ueda", aliases: ["ueda"] },
{ match: "takehiro tomiyasu", aliases: ["tomiyasu"] },
{ match: "lee kang in", aliases: ["lee kang-in", "kang in lee", "kang-in lee"] },
{ match: "hwang hee chan", aliases: ["hwang hee-chan", "hee chan hwang", "hee-chan hwang"] },
{ match: "cho gue sung", aliases: ["cho gue-sung", "gue sung cho", "gue-sung cho"] },

// --- EXTRA AFRICA ---
{ match: "kalidou koulibaly", aliases: ["koulibaly"] },
{ match: "edouard mendy", aliases: ["mendy"] },
{ match: "nicolas jackson", aliases: ["jackson", "nico jackson"] },
{ match: "ismaila sarr", aliases: ["sarr"] },
{ match: "pape matar sarr", aliases: ["pape sarr"] },
{ match: "ademola lookman", aliases: ["lookman"] },
{ match: "victor boniface", aliases: ["boniface"] },
{ match: "samuel chukwueze", aliases: ["chukwueze"] },
{ match: "alex iwobi", aliases: ["iwobi"] },
{ match: "mohammed salisu", aliases: ["salisu"] },
{ match: "thomas partey", aliases: ["partey"] },
{ match: "jordan ayew", aliases: ["ayew"] },
{ match: "omar marmoush", aliases: ["marmoush"] },
{ match: "riyad mahrez", aliases: ["mahrez"] },
{ match: "ismail bennacer", aliases: ["ismael bennacer", "bennacer"] },
{ match: "franck kessie", aliases: ["kessie"] },
{ match: "sebastien haller", aliases: ["haller"] },
{ match: "simon adingra", aliases: ["adingra"] },

// --- EXTRA SOUTH AMERICA ---
{ match: "moises caicedo", aliases: ["caicedo"] },
{ match: "willian pacho", aliases: ["pacho"] },
{ match: "piero hincapie", aliases: ["hincapie"] },
{ match: "pervis estupinan", aliases: ["estupinan"] },
{ match: "kendry paez", aliases: ["paez"] },
{ match: "enner valencia", aliases: ["enner", "valencia"] },
{ match: "jhon duran", aliases: ["duran"] },
{ match: "rafael santos borre", aliases: ["borre"] },
{ match: "davinson sanchez", aliases: ["sanchez"] },
{ match: "daniel munoz", aliases: ["munoz"] },
{ match: "jhon arias", aliases: ["arias"] },
{ match: "rodrigo bentancur", aliases: ["bentancur"] },
{ match: "facundo pellistri", aliases: ["pellistri"] },
{ match: "mathias olivera", aliases: ["olivera"] },
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

function uniqueStrings(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildFootballAliasIndex(entries = []) {
  const byMatch = new Map();
  const byToken = new Map();

  for (const entry of entries) {
    const match = normalizeSearchText(entry?.match);
    if (!match) continue;

    const aliases = uniqueStrings(
      (entry?.aliases || []).map((alias) => normalizeSearchText(alias))
    );

    byMatch.set(match, uniqueStrings([...(byMatch.get(match) || []), ...aliases]));

    for (const token of match.split(" ").filter(Boolean)) {
      const tokenEntries = byToken.get(token) || [];
      tokenEntries.push({ match, aliases });
      byToken.set(token, tokenEntries);
    }
  }

  return { byMatch, byToken };
}

const FOOTBALL_ALIAS_INDEX = buildFootballAliasIndex(FOOTBALL_ALIASES);

export function getAliasesForPlayerName(playerName) {
  const normalizedName = normalizeSearchText(playerName);
  if (!normalizedName) return [];

  const aliases = new Set();
  const addAliases = (values = []) => {
    for (const alias of values) {
      if (alias) aliases.add(alias);
    }
  };

  addAliases(FOOTBALL_ALIAS_INDEX.byMatch.get(normalizedName));

  const tokens = normalizedName.split(" ").filter(Boolean);
  for (const token of tokens) {
    addAliases(FOOTBALL_ALIAS_INDEX.byMatch.get(token));
  }

  const candidateEntries = new Map();
  for (const token of tokens) {
    for (const entry of FOOTBALL_ALIAS_INDEX.byToken.get(token) || []) {
      candidateEntries.set(entry.match, entry);
    }
  }

  for (const entry of candidateEntries.values()) {
    if (
      normalizedName.includes(entry.match) ||
      entry.match.includes(normalizedName)
    ) {
      addAliases(entry.aliases);
    }
  }

  return Array.from(aliases);
}

function generatedNameAliases(value) {
  const tokens = normalizeSearchText(value).split(" ").filter(Boolean);
  if (tokens.length < 2) return [];

  const first = tokens[0];
  const finalToken = tokens[tokens.length - 1];
  return [`${first} ${finalToken}`];
}

function manualFootballAliases(searchableText) {
  return getAliasesForPlayerName(searchableText);
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
    values.push(...getAliasesForPlayerName(name));
  }

  values.push(...manualFootballAliases(values.filter(Boolean).join(" ")));

  return normalizeSearchText(values.filter(Boolean).join(" "));
}

export function createSearchTextMatcher(query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return () => true;

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);

  return (searchableText) => {
    const normalizedSearchableText = String(searchableText || "");
    if (normalizedSearchableText.includes(normalizedQuery)) return true;

    return queryTokens.every((token) => normalizedSearchableText.includes(token));
  };
}

export function matchesPrecomputedSearchText(searchableText, query) {
  return createSearchTextMatcher(query)(searchableText);
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
