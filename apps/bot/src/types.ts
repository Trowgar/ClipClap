export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface KeyboardButton {
  text: string;
  /** Opens a Telegram Mini App. Private chats only, and tapping it opens the
   *  app instead of sending the button text, so no command parsing is needed. */
  web_app?: { url: string };
}

export interface ReplyKeyboardMarkup {
  keyboard: KeyboardButton[][];
  is_persistent?: boolean;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  selective?: boolean;
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

export type ReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove;

export interface TelegramMessage {
  message_id: number;
  media_group_id?: string;
  chat: {
    id: number;
    type: string;
  };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  video?: TelegramVideo;
  document?: TelegramDocument;
  /// Added 2026-08-21 for the support log only. The relay itself has always
  /// copied whatever arrived without inspecting it, but a screenshot is the
  /// most common thing a person sends support and recording it as "other"
  /// throws away the one detail that says what kind of help was being asked
  /// for. Telegram sends photos as an array of sizes; we only ever count it.
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessage;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}
