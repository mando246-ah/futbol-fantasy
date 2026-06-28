const newsPosts = [
  {
  id: "marketplace-recurring-schedules-custom-draft-order-and-knockouts",
  date: "2026-06-14",
  tag: "Draft & Marketplace",
  title: "Recurring Marketplace, Custom Draft Order, Turn Sounds, and Knockout Drafts",
  summary:
  "Hosts can now set recurring Marketplace schedules, customize draft order, and managers can enable a sound cue for their draft turn. World Cup Knockout drafts are also available.",
  body: [
  "We added new Marketplace scheduling options to make room management easier for hosts.",
  "Hosts can now choose between a one-time Marketplace schedule or a recurring schedule. With recurring schedules, hosts can pick the days and time when the Marketplace should open automatically, so they do not have to keep coming back to schedule it manually.",
  "When a host reschedules the Marketplace, the newest schedule now replaces the previous one. Pending Marketplace reminders are also reset so old schedule reminders do not continue after a new schedule is saved.",
  "We also added more control to the draft setup. Hosts can now choose between a random draft order or a custom draft order before the draft starts.",
  "Hosts can also choose the draft round style. Snake Draft reverses the order every round, while Fixed Order keeps the same order every round.",
  "Managers can now enable a sound cue for their draft turn. This can help users know when they are on the clock, especially during longer drafts or when they are checking another tab.",
  "Player search has also been improved with more nicknames and name variations, making it easier to find players during the draft.",
  "World Cup Knockout drafts are now available, so managers can create a new room and draft specifically for the knockout stage.",
  ],
  callout: {
    title: "💚 Community Update",
    text:
      "Thank you to everyone who has been testing rooms, reporting issues, and sending feedback. Many of these improvements came directly from your suggestions, and we’ll keep improving Fútbol Fantasy throughout the World Cup.",
  },
  bullets: [
  "Hosts can now schedule the Marketplace as one-time or recurring.",
  "Recurring Marketplace schedules can be set by selected days and time.",
  "Recurring Marketplace mode starts with no days selected until the host chooses them.",
  "Default Marketplace duration is now 15 minutes.",
  "Recurring Marketplace duration is limited to 22 hours and 59 minutes.",
  "Rescheduling the Marketplace now replaces the previous schedule.",
  "Pending Marketplace reminder emails are reset when a new schedule is saved.",
  "Hosts can now choose Random Draft Order or Custom Draft Order.",
  "Hosts can now choose Snake Draft or Fixed Draft order.",
  "Managers can enable a sound cue when it becomes their turn to draft.",
  "More player nicknames and name variations were added to draft search.",
  "World Cup Knockout drafts are now available.",
  ],
  isNew: true,
  },


  {
  id: "field-view-player-details-and-update-alerts",
  date: "2026-06-14",
  tag: "Tournament View",
  title: "New Field View, Player Details, and Update Alerts",
  summary:
  "Managers can now switch between the classic roster display and a new Field View with player cards, daily results, and clickable player details.",
  body: [
    "We added a new Field View option to the Tournament page so managers can view their starting XI on a soccer field with fantasy-style player cards.",
    "Managers can now switch between Legacy View and Field View. Legacy View keeps the original roster layout, while Field View gives a more visual lineup experience. Your selected view is remembered on the same device.",
    "Player cards now show key information like position, live status, club, country, and fantasy points. Long names are shortened on the cards to keep the field clean, while full names still appear in player details and other areas.",
    "Clicking or tapping one of your players in Field View now opens that player’s raw stats and points breakdown. On desktop, the field shifts left and the details appear on the right. On mobile, the details open in a clean popup over the field.",
    "Field View also includes a Daily Results section with day-specific manager points and game information when available.",
    "We also added an update alert system. When a new version of the site is available, users with old tabs open can now see a refresh message so they know there is a new update.",
    "These updates are part of our beta improvements to make tournaments easier to follow, more visual, and more mobile-friendly. Thank you for continuing to test and give feedback.",
  ],
  bullets: [
    "Added a new Field View for your starting XI.",
    "Managers can switch between Legacy View and Field View.",
    "Your selected roster view is remembered on the same device.",
    "Player cards now show position, live status, club, country, and points.",
    "Long player names are shortened on field cards only.",
    "Click a player card to view raw stats and points breakdown.",
    "Desktop now shows player details beside the field.",
    "Mobile now shows player details in a popup.",
    "Daily Results now appear inside Field View.",
    "Users can now see an update alert when a new site version is available.",
  ],
  isNew: false,
  },

  {
    id: "draft-search-and-market-player-pool-update",
    date: "2026-06-08",
    tag: "Draft & Marketplace",
    title: "Improved Draft Search and Updated Marketplace Player Pool",
    summary:
    "Draft search is now easier to use, and missing World Cup players have been added to the marketplace for existing rooms.",
    body: [
    "We made new improvements to the Draft experience to help managers find players faster and plan their picks better.",
    "Player search is now broader and more forgiving. Managers no longer need to type a player’s full legal name or use the exact accent marks to find someone. Common names, shorter names, nicknames, and some spelling variations should now be easier to search.",
    "Managers can also search and browse the player pool even when it is not their turn. This lets everyone plan ahead during the draft instead of waiting until they are on the clock.",
    "Only the manager whose turn it is can actually make a pick. When it becomes your turn, the player pool will show an active green highlight and the pick buttons will become available.",
    "We also repaired the World Cup player pool for existing rooms. Players that were missing from the original World Cup pool have now been added, and those undrafted players should be available in the marketplace.",
    "Future World Cup rooms will also check the global player pool freshness before seeding players. This helps prevent new rooms from using an outdated player list.",
    "Thank you to everyone who reported missing players and search issues. These updates are part of our beta process, and we will keep improving the draft and marketplace experience based on feedback.",
    ],
    bullets: [
    "Draft search now supports broader name matching.",
    "Players can be searched even when it is not your turn.",
    "Only the current manager can make a pick.",
    "Your turn is highlighted with a green active state.",
    "Missing World Cup players have been added to the marketplace.",
    "Future World Cup rooms now check for a fresher player pool before seeding.",
    ],
    isNew: false,
  },

  {
    id: "world-cup-group-stage-three-day-player-lock",
    date: "2026-06-08",
    tag: "World Cup Group Stage",
    title: "New 3-Day Player Lock for World Cup Group Stage Rooms",
    summary:
      "Starting XI players are now locked for three calendar days after making a real-life World Cup Group Stage appearance.",
    body: [
      "When a player in your starting XI appears in a real-life World Cup Group Stage match and plays at least one minute, that player becomes locked for three calendar days.",
      "While locked, the player must remain in the exact same starting slot. They cannot be moved, swapped, benched, or removed from your lineup.",
      "Players who do not appear in the match are not locked. Bench players also do not receive this lock because bench players do not score.",
      "This rule only applies to World Cup Group Stage rooms. It does not apply to Regular Season rooms, normal Cup rooms, or World Cup Knockout rooms.",
      "The change makes daily lineup choices more strategic and prevents fixture-spam substitutions across the busy group-stage schedule.",
      "We hope this adds an exciting new layer of strategy to your World Cup Daily experience instead of being a game of substitutions. Good luck to all managers in the tournament!",
    ],
    bullets: [
      "A real appearance of at least one minute triggers the lock.",
      "The lock lasts three calendar days in the competition timezone.",
      "Only starting XI players can receive this lock.",
      "Locked players stay in their exact starter slot until the lock expires.",
      "Hoping to add strategic depth and prevent a game of substitutions during the busy group stage schedule.",
    ],
    isNew: false,
  },
];

export default newsPosts;

