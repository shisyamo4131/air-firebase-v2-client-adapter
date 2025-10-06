/**
 * アプリ側で使用する FireModel のアダプターです。
 * FireModel に Firestore に対する CRUD 機能を注入します。
 */
import {
  collection,
  doc,
  getDoc,
  runTransaction,
  query,
  getDocs,
  where,
  orderBy,
  limit,
  collectionGroup,
  onSnapshot,
  getFirestore,
  increment as FieldValue_increment,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { ClientAdapterError, ERRORS } from "./error.js";

/*****************************************************************************
 * Client Adapter for FireModel version 1.0.0
 *
 * - This adapter is designed for client-side applications using Firebase.
 *****************************************************************************/
class ClientAdapter {
  static firestore = null;
  static auth = null;

  constructor() {
    ClientAdapter.firestore = getFirestore();
    ClientAdapter.auth = getAuth();
  }

  get type() {
    return "CLIENT";
  }

  /**
   * console を返します。
   * FireModel でコンソールを出力するために使用します。
   */
  get logger() {
    return console;
  }

  /**
   * Returns the Firestore instance.
   * - 2025-07-11 added
   */
  get firestore() {
    if (!ClientAdapter.firestore) {
      throw new ClientAdapterError(ERRORS.SYSTEM_FIRESTORE_NOT_INITIALIZED);
    }
    return ClientAdapter.firestore;
  }

  /**
   * Outputs an error message to the console.
   * - Use this method only for unexpected errors.
   * @param {string} funcName
   * @param {Error} err - The error object to log.
   */
  _outputErrorConsole(funcName, err) {
    console.error(
      `[ClientAdapter.js - ${funcName}] Unknown error has occurred:`,
      err
    );
  }

  /**
   * Assigns an autonumber to the instance using a Firestore transaction.
   * - Retrieves the current autonumber doc from the `Autonumbers` collection.
   * - Increments the number and sets it on the instance.
   * - Returns a function to update the `current` value in Firestore.
   * - `prefix` is used to resolve the collection path if provided.
   * @param {Object} args - Autonumber options.
   * @param {Object} args.transaction - Firestore transaction object (required).
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {Promise<Function>} Function that updates the current counter.
   * @throws {Error} If transaction is not provided or autonumber is invalid.
   */
  async setAutonumber({ transaction, prefix = null } = {}) {
    if (!transaction) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_TRANSACTION);
    }

    try {
      let effectivePrefix =
        prefix || this.constructor.getConfig()?.prefix || "";
      if (effectivePrefix && !effectivePrefix.endsWith("/")) {
        effectivePrefix += "/";
      }
      const collectionPath = effectivePrefix + "Autonumbers";
      const docRef = doc(collection(ClientAdapter.firestore, collectionPath));
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists()) {
        throw new ClientAdapterError(
          ERRORS.BUSINESS_AUTONUMBER_DOCUMENT_NOT_FOUND
        );
      }

      const data = docSnap.data();

      if (!data?.status) {
        throw new ClientAdapterError(ERRORS.BUSINESS_AUTONUMBER_DISABLED);
      }

      const newNumber = data.current + 1;
      const length = data.length;
      const maxValue = Math.pow(10, length) - 1;
      if (newNumber > maxValue) {
        throw new ClientAdapterError(ERRORS.BUSINESS_AUTONUMBER_MAX_REACHED);
      }

      const newCode = String(newNumber).padStart(length, "0");
      this[data.field] = newCode;

      return () => transaction.update(docRef, { current: newNumber });
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("setAutonumber", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Returns a function to update the counter document in Firestore.
   * - This function treats 'this' as a FireModel instance.
   * @param {Object} args - Parameters for counter update.
   * @param {Object} args.transaction - Firestore transaction object (required).
   * @param {boolean} [args.increment=true] - Whether to increment (true) or decrement (false) the counter.
   * @param {string|null} [args.prefix=null] - Optional path prefix for collection.
   * @returns {Promise<Function>} Function to update the counter document.
   */
  async getCounterUpdater(args = {}) {
    const { transaction, increment = true, prefix = null } = args;
    // transaction is required
    if (!transaction) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_TRANSACTION);
    }

    try {
      // Get collection path defined by class.
      // -> `getCollectionPath()` is a static method defined in FireModel.
      // ex) `customers` or `companies/{companyId}/customers`
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Divide collection path into segments.
      // ex) `["companies", "{companyId}", "customers"]`
      const segments = collectionPath.split("/");

      // Get collection name (Last segment is collection name)
      const colName = segments.pop();

      // Determine effective collection path for counter-document.
      const effectiveDocPath = `${segments.join("/")}/meta/docCounter`;
      const docRef = doc(ClientAdapter.firestore, effectiveDocPath);
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists()) {
        return () => transaction.set(docRef, { [colName]: increment ? 1 : 0 });
      } else {
        return () =>
          transaction.update(docRef, {
            [colName]: FieldValue_increment(increment ? 1 : -1),
          });
      }
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("getCounterUpdater", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Create a new document in Firestore.
   * @param {Object} args - Creation options.
   * @param {string} [args.docId] - Document ID to use (optional).
   * @param {boolean} [args.useAutonumber=true] - Whether to use auto-numbering.
   * @param {Object} [args.transaction] - Firestore transaction.
   * @param {Function} [args.callBack] - Callback function.
   * @param {string} [args.prefix] - Path prefix.
   * @returns {Promise<DocumentReference>} Reference to the created document.
   * @throws {Error} If creation fails or `callBack` is not a function.
   */
  async create(args = {}) {
    const { docId, useAutonumber = true, transaction, callBack, prefix } = args;

    // `callBack` must be a function if provided.
    if (callBack && typeof callBack !== "function") {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CALLBACK);
    }

    try {
      // Pre-create hooks and validation
      await this.beforeCreate();
      await this.beforeEdit();
      this.validate();

      // transaction processing
      const performTransaction = async (txn) => {
        // Get function to update autonumber if `useAutonumber` is true.
        const updateAutonumber =
          this.constructor.useAutonumber && useAutonumber
            ? await this.setAutonumber({ transaction: txn, prefix })
            : null;

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: true,
          prefix,
        });

        // Prepare document reference
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = collection(
          ClientAdapter.firestore,
          collectionPath
        ).withConverter(this.constructor.converter());
        const docRef = docId ? doc(colRef, docId) : doc(colRef);

        // Set metadata
        this.docId = docRef.id;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        this.uid = ClientAdapter.auth?.currentUser?.uid || "unknown";

        // Create document
        txn.set(docRef, this);

        // Update autonumber if applicable
        if (updateAutonumber) await updateAutonumber();

        // Update counter document
        if (counterUpdater) await counterUpdater();

        // Execute callback if provided
        if (callBack) await callBack(txn);

        // Return document reference
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await runTransaction(ClientAdapter.firestore, performTransaction);

      return docRef;
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("create", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Get a document from Firestore by its ID and load into this instance.
   * - The class properties will be cleared if the document does not exist.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<boolean>} True if document was found and loaded, false if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetch(args = {}) {
    const { docId, transaction = null, prefix = null } = args;
    if (!docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }
    try {
      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);

      // Fetch document snapshot.
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await getDoc(docRef);

      // Load data into this instance, or reset if not found.
      this.initialize(docSnap.exists() ? docSnap.data() : null);

      return docSnap.exists();
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("fetch", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Get a document from Firestore by its ID and return as a new instance.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<Object|null>} Document data, or null if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetchDoc(args = {}) {
    const { docId, transaction = null, prefix = null } = args;
    // Throw error if docId is not provided.
    if (!docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }
    try {
      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);

      // Fetch document snapshot.
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await getDoc(docRef);

      return docSnap.exists() ? docSnap.data() : null;
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("fetchDoc", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Firestore のクエリ条件の配列を受け取り、Firestore のクエリオブジェクト配列を生成して返します。
   * - `constraints` 配列には、`where`, `orderBy`, `limit` などの Firestore クエリを指定できます。
   * - 例：`[['where', 'age', '>=', 18], ['orderBy', 'age', 'desc'], ['limit', 10]]`
   * - 不明なクエリタイプが指定された場合はエラーをスローします。
   *
   * @param {Array} constraints - クエリ条件の配列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - 不明なクエリタイプが指定された場合、エラーをスローします。
   */
  createQueries(constraints) {
    const result = [];
    constraints.forEach((constraint) => {
      const [type, ...args] = constraint;

      switch (type) {
        case "where":
          result.push(where(...args));
          break;
        case "orderBy":
          if (!["asc", "desc"].includes(args[1] || "asc")) {
            throw new ClientAdapterError(
              ERRORS.VALIDATION_INVALID_ORDERBY_DIRECTION
            );
          }
          result.push(orderBy(args[0], args[1] || "asc"));
          break;
        case "limit":
          if (typeof args[0] !== "number" || args[0] <= 0) {
            throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_LIMIT);
          }
          result.push(limit(args[0]));
          break;
        default:
          throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_QUERY_TYPE);
      }
    });
    return result;
  }

  /**
   * Firestore の `tokenMap` に基づく N-Gram 検索用のクエリオブジェクトを生成します。
   * - 検索文字列の 1 文字・2 文字ごとのトークンを作成し、Firestore の `tokenMap` を利用した検索クエリを生成します。
   * - 例：`"検索"` → `['検', '索', '検索']`
   * - サロゲートペア文字（絵文字など）は Firestore の `tokenMap` では検索対象としないため除外します。
   *
   * @param {string} constraints - 検索に使用する文字列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - `constraints` が空文字の場合、エラーをスローします。
   */
  createTokenMapQueries(constraints) {
    if (!constraints || constraints.trim().length === 0) {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CONSTRAINTS);
    }

    const result = new Set(); // クエリの重複を防ぐために `Set` を使用

    // サロゲートペア文字（絵文字など）を除外
    const target = constraints.replace(
      /[\uD800-\uDBFF]|[\uDC00-\uDFFF]|~|\*|\[|\]|\s+/g,
      ""
    );

    // 1 文字・2 文字のトークンを生成
    const tokens = [
      ...new Set([
        ...[...target].map((_, i) => target.substring(i, i + 1)), // 1 文字トークン
        ...[...target].map((_, i) => target.substring(i, i + 2)).slice(0, -1), // 2 文字トークン
      ]),
    ];

    // Firestore クエリオブジェクトを作成
    tokens.forEach((token) => {
      result.add(where(`tokenMap.${token}`, "==", true));
    });

    return Array.from(result); // `Set` を配列に変換して返す
  }

  /**
   * クエリ条件に一致するドキュメントを Firestore から取得します。
   * - `constraints` が文字列なら N-gram 検索を実行します。
   * - 配列なら通常のクエリ検索を行います。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * [NOTE]
   * - 2025/10/06 現在、transaction.get() に Query を指定することはできない仕様。
   *   そのため、依存ドキュメントの存在確認には getDocs() を使用することになるが、
   *   transaction 内での読み取りにならず、当該処理の直後に他のプロセスから依存ドキュメントが
   *   追加された場合に整合性を失う可能性あり。
   *   引数 transaction が本来であれば不要だが、将来的に transaction.get() が
   *   Query に対応した場合に備えて引数として受け取る形にしておく。
   *
   * @param {Object} args - Fetch options.
   * @param {Array|string} args.constraints - Query condition array or search string.
   * @param {Array} [args.options=[]] - Additional query filters (ignored if constraints is an array).
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<Array<Object>>} Array of document data.
   * @throws {Error} If constraints are invalid or Firestore query fails.
   */
  async fetchDocs({
    constraints = [],
    options = [],
    transaction = null,
    prefix = null,
  } = {}) {
    const queryConstraints = [];

    if (typeof constraints === "string") {
      queryConstraints.push(...this.createTokenMapQueries(constraints));
      queryConstraints.push(...this.createQueries(options));
    } else if (Array.isArray(constraints)) {
      queryConstraints.push(...this.createQueries(constraints));
    } else {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CONSTRAINTS);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());

      const queryRef = query(colRef, ...queryConstraints);

      /** transaction.get() が Query に対応した場合は以下をコメントアウト */
      const querySnapshot = await getDocs(queryRef);

      /** transaction.get() が Query に対応した場合は以下を使用 */
      // const querySnapshot = transaction
      //   ? await transaction.get(queryRef)
      //   : await getDocs(queryRef);

      return querySnapshot.docs.map((doc) => doc.data());
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("fetchDocs", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * 指定されたドキュメント ID の配列に該当するドキュメントを取得して返します。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * [NOTE]
   * - 2025/10/06 現在、transaction.get() に Query を指定することはできない仕様。
   *   そのため、依存ドキュメントの存在確認には getDocs() を使用することになるが、
   *   transaction 内での読み取りにならず、当該処理の直後に他のプロセスから依存ドキュメントが
   *   追加された場合に整合性を失う可能性あり。
   *   引数 transaction が本来であれば不要だが、将来的に transaction.get() が
   *   Query に対応した場合に備えて引数として受け取る形にしておく。
   *
   * @param {Object} args - Fetch options.
   * @param {Array<string>} args.ids - Document ID の配列。
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<Array<Object>>} Array of document data.
   */
  async fetchDocsByIds({ ids = [], transaction = null, prefix = null } = {}) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return [];

      const uniqueIds = Array.from(new Set(ids));
      const chunkedIds = uniqueIds.flatMap((_, i, a) => {
        return i % 30 ? [] : [a.slice(i, i + 30)];
      });

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());

      const querySnapshotArray = await Promise.all(
        chunkedIds.map((chunkedId) => {
          const q = query(colRef, where("docId", "in", chunkedId));
          return getDocs(q);
          /** transaction.get() が Query に対応した場合は以下を使用 */
          // return transaction ? transaction.get(q) : getDocs(q);
        })
      );

      return querySnapshotArray.flatMap((snapshot) =>
        snapshot.docs.map((doc) => doc.data())
      );
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("fetchDocsByIds", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Updates the Firestore document using the current instance data.
   * - Requires `this.docId` to be set (must call `fetch()` beforehand).
   * - Runs inside a transaction. If not provided, a new one will be created.
   * - If `callBack` is specified, it will be executed after the update.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * Firestore ドキュメントを現在のプロパティ値で更新します。
   * - `this.docId` が設定されていない場合はエラーになります（事前に `fetch()` を実行してください）。
   * - 更新はトランザクション内で行われます。トランザクションが指定されない場合は新たに生成されます。
   * - `callBack` が指定されていれば、更新後に実行されます。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Parameters for update operation.
   *                        更新処理のためのパラメータ。
   * @param {Object|null} [args.transaction=null] - Firestore transaction object.
   *                                                Firestore のトランザクションオブジェクト。
   * @param {function|null} [args.callBack=null] - Callback executed after update.
   *                                               更新後に実行されるコールバック関数。
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   *                                           コレクションパスのプレフィックス（任意）。
   * @returns {Promise<DocumentReference>} Reference to the updated document.
   *                                       更新されたドキュメントのリファレンス。
   * @throws {Error} If `docId` is not set, or if `callBack` is not a function.
   *                 `docId` が未設定、または `callBack` が関数でない場合にスローされます。
   */
  async update({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CALLBACK);
    }

    if (!this.docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }

    try {
      await this.beforeUpdate();
      await this.beforeEdit();
      this.validate();

      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = collection(
          ClientAdapter.firestore,
          collectionPath
        ).withConverter(this.constructor.converter());
        const docRef = doc(colRef, this.docId);

        this.updatedAt = new Date();
        this.uid = ClientAdapter.auth?.currentUser?.uid || "unknown";

        txn.set(docRef, this);
        if (callBack) await callBack(txn);
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await runTransaction(ClientAdapter.firestore, performTransaction);

      return docRef;
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("update", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Checks if any child documents exist for this document, based on `hasMany` configuration.
   * - For collections, the prefix is applied to the collection path.
   *
   * [NOTE]
   * - 2025/10/06 現在、transaction.get() に Query を指定することはできない仕様。
   *   そのため、依存ドキュメントの存在確認には getDocs() を使用することになるが、
   *   transaction 内での読み取りにならず、当該処理の直後に他のプロセスから依存ドキュメントが
   *   追加された場合に整合性を失う可能性あり。
   *   引数 transaction が本来であれば不要だが、将来的に transaction.get() が
   *   Query に対応した場合に備えて引数として受け取る形にしておく。
   *
   * @param {Object} args - Options for the check.
   * @param {Object|null} [args.transaction=null] - Firestore transaction object (optional).
   * @param {string|null} [args.prefix=null] - Optional path prefix for resolving collections.
   * @returns {Promise<object|boolean>} Matching `hasMany` item if found, otherwise false.
   * @throws {Error} If `docId` is not set or query fails.
   */
  async hasChild({ transaction = null, prefix = null } = {}) {
    try {
      if (!this.docId) {
        throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
      }

      for (const item of this.constructor.hasMany) {
        const collectionPath =
          item.type === "collection" && prefix
            ? `${prefix}${item.collectionPath}`
            : item.collectionPath;
        const colRef =
          item.type === "collection"
            ? collection(ClientAdapter.firestore, collectionPath)
            : collectionGroup(ClientAdapter.firestore, item.collectionPath);
        const constraint = where(item.field, item.condition, this.docId);
        const queryRef = query(colRef, constraint, limit(1));

        /** transaction.get() が Query に対応した場合は以下をコメントアウト */
        const snapshot = await getDocs(queryRef);

        /** transaction.get() が Query に対応した場合は以下を使用 */
        // const snapshot = transaction
        //   ? await transaction.get(queryRef)
        //   : await getDocs(queryRef);

        if (!snapshot.empty) return item;
      }

      return false;
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("hasChild", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Deletes the document corresponding to the current `docId`.
   * - If `logicalDelete` is enabled, the document is moved to an archive collection instead of being permanently deleted.
   * - If `transaction` is provided, the deletion is executed within it.
   * - If `prefix` is provided, it will be used to resolve the collection path.
   *
   * 現在の `docId` に該当するドキュメントを削除します。
   * - `logicalDelete` が true の場合、ドキュメントは物理削除されず、アーカイブコレクションに移動されます。
   * - `transaction` が指定されている場合、その中で処理が実行されます。
   * - `prefix` が指定されている場合、それを使ってコレクションパスを解決します。
   *
   * @param {Object} args - Parameters for deletion.
   *                        削除処理のパラメータ。
   * @param {Object|null} [args.transaction=null] - Firestore transaction object (optional).
   *                                                Firestore のトランザクションオブジェクト（任意）。
   * @param {function|null} [args.callBack=null] - Callback executed after deletion (optional).
   *                                               削除後に実行されるコールバック関数（任意）。
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   *                                           コレクションパスのプレフィックス（任意）。
   * @returns {Promise<void>} Resolves when deletion is complete.
   *                          削除が完了したら解決されるプロミス。
   * @throws {Error} If `docId` is missing, `callBack` is not a function, or document is undeletable.
   *                 `docId` が未設定、`callBack` が関数でない、または削除対象のドキュメントが存在しない場合。
   */
  async delete({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CALLBACK);
    }

    if (!this.docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }

    try {
      await this.beforeDelete();

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(ClientAdapter.firestore, collectionPath);
      const docRef = doc(colRef, this.docId);

      const performTransaction = async (txn) => {
        // Check for child documents before deletion
        // If child documents exist, throw an error to prevent deletion
        const hasChild = await this.hasChild({
          transaction: txn,
          prefix: prefix || this.constructor?.config?.prefix,
        });
        if (hasChild) {
          throw new ClientAdapterError(ERRORS.BUSINESS_CHILD_DOCUMENTS_EXIST);
        }

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: false,
          prefix,
        });

        // If logicalDelete is enabled, archive the document before deletion
        if (this.constructor.logicalDelete) {
          // Fetch the document to be deleted
          // This is necessary because in a transaction, docRef.get() cannot be used directly
          // and we need to ensure the document exists before archiving
          const sourceDocSnap = await txn.get(docRef);
          if (!sourceDocSnap.exists()) {
            throw new ClientAdapterError(ERRORS.DATABASE_DOCUMENT_NOT_FOUND);
          }

          const sourceDocData = sourceDocSnap.data();
          const archiveColRef = collection(
            ClientAdapter.firestore,
            `${collectionPath}_archive`
          );
          const archiveDocRef = doc(archiveColRef, this.docId);
          txn.set(archiveDocRef, sourceDocData);
        }

        txn.delete(docRef);

        if (counterUpdater) await counterUpdater();

        if (callBack) await callBack(txn);
      };

      if (transaction) {
        await performTransaction(transaction);
      } else {
        await runTransaction(ClientAdapter.firestore, performTransaction);
      }
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("delete", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Restores a deleted document from the archive collection to the original collection.
   * - Uses `prefix` to resolve the Firestore collection path.
   *
   * アーカイブコレクションから削除されたドキュメントを元のコレクションに復元します。
   * - `prefix` が指定されていれば、それに基づいてコレクションパスを解決します。
   *
   * @param {Object} args - Restore options.
   * @param {string} args.docId - Document ID to restore.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {Promise<DocumentReference>} Reference to the restored document.
   * @throws {Error} If document is not found in the archive.
   */
  async restore({ docId, prefix = null, transaction = null } = {}) {
    if (!docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }
    try {
      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const archivePath = `${collectionPath}_archive`;
        const archiveColRef = collection(ClientAdapter.firestore, archivePath);
        const archiveDocRef = doc(archiveColRef, docId);
        const docSnapshot = await txn.get(archiveDocRef);
        if (!docSnapshot.exists()) {
          throw new ClientAdapterError(ERRORS.DATABASE_DOCUMENT_NOT_FOUND);
        }

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: true,
          prefix,
        });

        const colRef = collection(ClientAdapter.firestore, collectionPath);
        const docRef = doc(colRef, docId);
        txn.delete(archiveDocRef);
        txn.set(docRef, docSnapshot.data());

        if (counterUpdater) await counterUpdater();

        return docRef;
      };

      if (transaction) {
        return await performTransaction(transaction);
      } else {
        return await runTransaction(
          ClientAdapter.firestore,
          performTransaction
        );
      }
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("restore", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Unsubscribes from the active Firestore real-time listener, if one exists.
   * - Also clears the local document array (`this.docs`).
   *
   * Firestore のリアルタイムリスナーを解除します。
   * - 現在のリスナーが存在する場合、それを解除します。
   * - さらに、`this.docs` に格納されていたドキュメントデータもクリアします。
   *
   * @returns {void}
   */
  unsubscribe() {
    if (this.listener) {
      this.listener();
      this.listener = null;
    }
    this.docs.splice(0);
  }

  /**
   * Sets a real-time listener on a Firestore document and initializes the instance with its data.
   * - If a listener already exists, it will be unsubscribed first.
   *
   * Firestore のドキュメントに対してリアルタイムリスナーを設定し、
   * ドキュメントのデータでインスタンスを初期化します。
   *
   * @param {Object} args - Subscribe options.
   * @param {string} args.docId - Document ID to subscribe to.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {void}
   * @throws {Error} If docId is missing.
   */
  subscribe({ docId, prefix = null } = {}) {
    this.unsubscribe();

    if (!docId) {
      throw new ClientAdapterError(ERRORS.VALIDATION_MISSING_DOC_ID);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      // const colRef = collection(ClientAdapter.firestore, collectionPath);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);
      this.listener = onSnapshot(docRef, (docSnapshot) => {
        this.initialize(docSnapshot.data());
      });
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("subscribe", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }

  /**
   * Sets a real-time listener on a Firestore collection and monitors changes.
   * - If `constraints` is a string, performs N-gram search using `tokenMap`.
   * - If `constraints` is an array, applies Firestore query conditions.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * Firestore コレクションに対してリアルタイムリスナーを設定し、
   * ドキュメントの変更を監視します。
   *
   * @param {Object} args - Subscribe options.
   * @param {Array|string} args.constraints - Query condition array or search string.
   * @param {Array} [args.options=[]] - Additional query conditions.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @param {function|null} [args.callback=null] - Callback executed on document changes.
   * @returns {Array<Object>} Live-updated document data.
   */
  subscribeDocs({
    constraints = [],
    options = [],
    prefix = null,
    callback,
  } = {}) {
    this.unsubscribe();
    const queryConstraints = [];

    if (typeof constraints === "string") {
      queryConstraints.push(...this.createTokenMapQueries(constraints));
      queryConstraints.push(...this.createQueries(options));
    } else if (Array.isArray(constraints)) {
      queryConstraints.push(...this.createQueries(constraints));
    } else {
      throw new ClientAdapterError(ERRORS.VALIDATION_INVALID_CONSTRAINTS);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const queryRef = query(colRef, ...queryConstraints);

      this.listener = onSnapshot(queryRef, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const item = change.doc.data();
          const index = this.docs.findIndex(
            ({ docId }) => docId === item.docId
          );
          if (change.type === "added") this.docs.push(item);
          if (change.type === "modified") this.docs.splice(index, 1, item);
          if (change.type === "removed") this.docs.splice(index, 1);
          if (callback) callback(item, change.type);
        });
      });

      return this.docs;
    } catch (err) {
      if (err instanceof ClientAdapterError) {
        throw err;
      } else {
        this._outputErrorConsole("subscribeDocs", err);
        throw new ClientAdapterError(ERRORS.SYSTEM_UNKNOWN_ERROR);
      }
    }
  }
}

export default ClientAdapter;
