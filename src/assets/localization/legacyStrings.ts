import type { ApiOldLangPack } from '../../api/types';

// English for the legacy keys this interface shows. Telegram serves those packs from its own servers, which Onymgram
// never contacts; a key missing here falls back to the bundled strings (see `oldLangProvider`)
const legacyStrings: ApiOldLangPack = {
  Members: { oneValue: '%1$d member', otherValue: '%1$d members' },
  'GroupInfo.Title': 'Group Info',
  lng_info_user_title: 'User Info',
  'Conversation.SearchPlaceholder': 'Search',
  FilterByUser: 'Filter by member',
  NoResultFoundFor: 'No results for “%1$@”',
  lng_context_copy_text: 'Copy Text',
  lng_context_copy_selected_items: 'Copy Selected as Text',
  'MuteFor.Hours': { oneValue: 'For %1$d hour', otherValue: 'For %1$d hours' },
  'MuteFor.Days': { oneValue: 'For %1$d day', otherValue: 'For %1$d days' },
  'MuteFor.Forever': 'Forever',
  'Common.Done': 'Done',
  lng_month1: 'January',
  lng_month2: 'February',
  lng_month3: 'March',
  lng_month4: 'April',
  lng_month5: 'May',
  lng_month6: 'June',
  lng_month7: 'July',
  lng_month8: 'August',
  lng_month9: 'September',
  lng_month10: 'October',
  lng_month11: 'November',
  lng_month12: 'December',
  lng_weekday1: 'Mon',
  lng_weekday2: 'Tue',
  lng_weekday3: 'Wed',
  lng_weekday4: 'Thu',
  lng_weekday5: 'Fri',
  lng_weekday6: 'Sat',
  lng_weekday7: 'Sun',
};

export default legacyStrings;
