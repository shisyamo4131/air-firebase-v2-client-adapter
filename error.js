export class ClientAdapterError extends Error {
  constructor(errorInfo, originalError = null) {
    super(errorInfo.message);
    this.name = "ClientAdapterError";
    this.code = errorInfo.code;
    this.userMessage = errorInfo.userMessage;
    this.originalError = originalError;
  }

  /**
   * Checks if the error belongs to a specific category.
   * @param {string} category
   * @returns {boolean} - True if the error code starts with the category, otherwise false.
   */
  isCategory(category) {
    return this.code.startsWith(category);
  }

  /**
   * Returns a user-friendly message.
   * @returns {string} - The user-friendly error message.
   */
  getUserMessage() {
    return this.userMessage || this.message;
  }
}

/*****************************************************************************
 * DEFINED ERROR CODES
 *****************************************************************************/
export const ERRORS = {
  // 入力検証エラー (VALIDATION)
  VALIDATION_MISSING_DOC_ID: {
    code: "VALIDATION/MISSING_DOC_ID",
    message: "docId is required",
    userMessage: "ドキュメントIDが指定されていません",
  },
  VALIDATION_MISSING_TRANSACTION: {
    code: "VALIDATION/MISSING_TRANSACTION",
    message: "transaction is required",
    userMessage: "トランザクションが必要です",
  },
  VALIDATION_INVALID_CALLBACK: {
    code: "VALIDATION/INVALID_CALLBACK",
    message: "callback must be a function",
    userMessage: "コールバック関数が不正です",
  },
  VALIDATION_INVALID_ORDERBY_DIRECTION: {
    code: "VALIDATION/INVALID_ORDERBY_DIRECTION",
    message: "orderBy direction must be 'asc' or 'desc'",
    userMessage: "orderBy の方向は 'asc' または 'desc' でなければなりません",
  },
  VALIDATION_INVALID_QUERY_TYPE: {
    code: "VALIDATION/INVALID_QUERY_TYPE",
    message: "invalid query type",
    userMessage: "クエリタイプが不正です",
  },
  VALIDATION_INVALID_LIMIT: {
    code: "VALIDATION/INVALID_LIMIT",
    message: "limit must be a positive number",
    userMessage: "limit は正の数でなければなりません",
  },
  VALIDATION_INVALID_CONSTRAINTS: {
    code: "VALIDATION/INVALID_CONSTRAINTS",
    message: "invalid query constraints",
    userMessage: "クエリ条件が不正です",
  },
  VALIDATION_EMPTY_SEARCH_STRING: {
    code: "VALIDATION/EMPTY_SEARCH_STRING",
    message: "search string cannot be empty",
    userMessage: "検索文字列を入力してください",
  },

  // データベース操作エラー (DATABASE)
  DATABASE_DOCUMENT_NOT_FOUND: {
    code: "DATABASE/DOCUMENT_NOT_FOUND",
    message: "document not found",
    userMessage: "指定されたドキュメントが見つかりません",
  },
  DATABASE_TRANSACTION_FAILED: {
    code: "DATABASE/TRANSACTION_FAILED",
    message: "transaction failed",
    userMessage: "データの更新に失敗しました",
  },
  DATABASE_QUERY_FAILED: {
    code: "DATABASE/QUERY_FAILED",
    message: "query execution failed",
    userMessage: "データの取得に失敗しました",
  },
  DATABASE_CONNECTION_ERROR: {
    code: "DATABASE/CONNECTION_ERROR",
    message: "database connection error",
    userMessage: "データベースに接続できません",
  },

  // ビジネスロジックエラー (BUSINESS)
  BUSINESS_CHILD_DOCUMENTS_EXIST: {
    code: "BUSINESS/CHILD_DOCUMENTS_EXIST",
    message: "child documents exist",
    userMessage: "関連するドキュメントが存在するため削除できません",
  },
  BUSINESS_AUTONUMBER_DOCUMENT_NOT_FOUND: {
    code: "BUSINESS/AUTONUMBER_DOCUMENT_NOT_FOUND",
    message: "autonumber document not found",
    userMessage: "自動採番ドキュメントが見つかりません",
  },
  BUSINESS_AUTONUMBER_DISABLED: {
    code: "BUSINESS/AUTONUMBER_DISABLED",
    message: "autonumber is disabled",
    userMessage: "自動採番が無効になっています",
  },
  BUSINESS_AUTONUMBER_MAX_REACHED: {
    code: "BUSINESS/AUTONUMBER_MAX_REACHED",
    message: "autonumber maximum reached",
    userMessage: "採番の上限に達しています",
  },
  BUSINESS_DOCUMENT_UNDELETABLE: {
    code: "BUSINESS/DOCUMENT_UNDELETABLE",
    message: "document cannot be deleted",
    userMessage: "このドキュメントは削除できません",
  },

  // システムエラー (SYSTEM)
  SYSTEM_FIRESTORE_NOT_INITIALIZED: {
    code: "SYSTEM/FIRESTORE_NOT_INITIALIZED",
    message: "Firestore not initialized",
    userMessage: "データベースが初期化されていません",
  },
  SYSTEM_UNKNOWN_ERROR: {
    code: "SYSTEM/UNKNOWN_ERROR",
    message: "unknown error occurred",
    userMessage: "予期しないエラーが発生しました",
  },
};
