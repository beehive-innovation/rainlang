import toposort from "toposort";
import { Rainlang } from "./rainlang";
import { Meta } from "@rainprotocol/meta";
import { 
    fillIn,  
    hexlify, 
    ParsedChunk, 
    trackedTrim, 
    execBytecode, 
    hasDuplicate, 
    getRandomInt, 
    inclusiveParse, 
    exclusiveParse, 
    isConsumableMeta, 
    uint8ArrayToString
} from "./helpers";
import { 
    AST, 
    Range, 
    ErrorCode, 
    HEX_PATTERN,
    HASH_PATTERN, 
    TextDocument, 
    WORD_PATTERN,
    NUMERIC_PATTERN, 
    DEFAULT_ELISION,
    NATIVE_PARSER_ABI 
} from "../languageTypes";
// import { Compile } from "./compiler";


/**
 * @public
 * RainDocument aka dotrain is a class object that parses a text to provides data and 
 * functionalities in order to be used later on to provide Rain Language 
 * Services or in RainDocument compiler to get the ExpressionConfig 
 * (deployable bytes). It uses Rain parser under the hood which does all the 
 * heavy work.
 * 
 * @example
 * ```typescript
 * // to import
 * import { RainDocument } from 'rainlang';
 *
 * // to create a new instance of the RainDocument object which parses right after instantiation
 * const myRainDocument = await RainDocument.create(text)
 *
 * // to get the problems
 * const problems = myRainDocument.getAllProblems()
 *
 * // to update the text
 * await myRainDocument.updateText(newText)
 * ```
 */
export class RainDocument {

    public readonly constants: Record<string, string> = {
        "infinity"      : "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "max-uint256"   : "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "max-uint-256"  : "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    public metaStore: Meta.Store;
    public textDocument: TextDocument;
    public runtimeError: Error | undefined;
    public bindings: AST.Binding[] = [];
    public namespace: AST.Namespace = {};
    public imports: AST.Import[] = [];

    public authoringMeta: Meta.Authoring[] = [];
    public authoringMetaPath = "";
    public bytecode = "";
    public comments: AST.Comment[] = [];
    public problems: AST.Problem[] = [];

    private importDepth = 0;
    private _ignoreAM = false;
    private _ignoreUAM = false;
    private _shouldSearch = true;

    /**
     * @public Constructs a new RainDocument instance, should not be used for instantiating, use "creat()" instead
     * @param textDocument - TextDocument
     * @param metaStore - (optional) Meta.Store object
     */
    constructor(
        textDocument: TextDocument,
        metaStore?: Meta.Store,
        importDepth = 0
    ) {
        this.importDepth = importDepth;
        this.textDocument = textDocument;
        if (metaStore) this.metaStore = metaStore;
        else this.metaStore = new Meta.Store();
    }

    /**
     * @public Creates a new RainDocument object instance with a TextDocument
     * 
     * @param textDocument - The text document
     * @param metaStore - (optional) The initial Meta.Store object
     * @returns A new RainDocument instance
     */
    public static async create(
        textDocument: TextDocument, 
        metaStore?: Meta.Store
    ): Promise<RainDocument>

    /**
     * @public Creates a new RainDocument object instance from a text string
     * 
     * @param text - The text string
     * @param metaStore - (optional) The initial Meta.Store object
     * @param uri - (optional) The URI of the text, URI is the unique identifier of a TextDocument
     * @param version - (optional) The version of the text
     * @returns A new RainDocument instance
     */
    public static async create(
        text: string, 
        metaStore?: Meta.Store, 
        uri?: string, 
        version?: number
    ): Promise<RainDocument>

    public static async create(
        content: TextDocument | string, 
        metaStore?: Meta.Store, 
        uri?: string, 
        version?: number
    ): Promise<RainDocument> {
        let _rainDocument: RainDocument;
        if (typeof content === "string") _rainDocument = new RainDocument(
            TextDocument.create(
                uri ?? "untitled-" + getRandomInt(1000000000).toString() + ".rain", 
                "rainlang", 
                version === undefined || version < 0 ? 0 : version, 
                content
            ), 
            metaStore
        );
        else _rainDocument = new RainDocument(content, metaStore);
        await _rainDocument.parse();
        return _rainDocument;
    }

    /**
     * @public Updates the TextDocument of this RainDocument instance with new text
     * @param newText - The new text
     */
    public async updateText(newText: string): Promise<void>;

    /**
     * @public Updates the TextDocument of this RainDocument instance
     * @param newTextDocument - The new TextDocument
     */
    public async updateText(newTextDocument: TextDocument): Promise<void>;

    public async updateText(newContent: string | TextDocument) {
        if (typeof newContent === "string") this.textDocument = TextDocument.update(
            this.textDocument, 
            [{ text: newContent }], 
            this.textDocument.version + 1
        );
        else this.textDocument = newContent;
        await this.parse();
    }

    /**
     * @public Get the current text of this RainDocument instance
     */
    public getText(): string {
        return this.textDocument.getText();
    }

    /**
     * @public Get all problems of this RainDocument instance
     */
    public getAllProblems(): AST.Problem[] {
        return [...this.problems, ...this.getBindingsProblems()];
    }

    /**
     * @public Get the expression problems of this RainDocument instance
     */
    public getBindingsProblems(): AST.Problem[] {
        return this.bindings.flatMap(v => v.problems);
    }

    /**
     * @public
     * Parses this instance of RainDocument
     */
    public async parse() {
        if (/[^\s]/.test(this.textDocument.getText())) {
            try { 
                await this._parse(); 
            }
            catch (runtimeError) {
                if (runtimeError instanceof Error) this.runtimeError = runtimeError;
                else this.runtimeError = new Error(runtimeError as string);
                this.problems.push({
                    msg: `Runtime Error: ${
                        this.runtimeError.message
                    }`,
                    position: [0, -1],
                    code: ErrorCode.RuntimeError
                });
            }
        }
        else {
            this.authoringMeta      = [];
            this.imports            = [];
            this.problems           = [];
            this.comments           = [];
            this.bindings           = [];
            this.namespace          = {};
            this.authoringMetaPath  = "";
            this.bytecode           = "";
            this._ignoreAM          = false;
            this._ignoreUAM         = false;
            this.runtimeError       = undefined;
        }
    }

    // /**
    //  * @internal Method to find index of next element within the text
    //  */
    // private findNextBoundry(str: string): number {
    //     return str.search(/[\s]/g);
    // }

    /**
     * @internal Get context aliases from a contract meta
     */
    private toContextAlias(contractMeta: Meta.Contract): AST.ContextAlias[] {
        const _ctxAliases: AST.ContextAlias[] = [];
        contractMeta.methods.forEach(method => {
            method.expressions.forEach(exp => {
                exp.contextColumns?.forEach(ctxCol => {
                    const colIndex = _ctxAliases.findIndex(e => 
                        e.name === ctxCol.alias && (
                            e.column !== ctxCol.columnIndex || !isNaN(e.row)
                        )
                    );
                    if (colIndex > -1) throw new Error(
                        `duplicate context alias identifier: ${ctxCol.alias}`
                    );
                    else {
                        if (!_ctxAliases.find(e => e.name === ctxCol.alias)) {
                            _ctxAliases.push({
                                name: ctxCol.alias,
                                column: ctxCol.columnIndex,
                                row: NaN,
                                description: ctxCol.desc ?? ""
                            }); 
                        }  
                    }
                    ctxCol.cells?.forEach(ctxCell => {
                        const cellIndex = _ctxAliases.findIndex(
                            e => e.name === ctxCell.alias && (
                                e.column !== ctxCol.columnIndex || 
                                e.row !== ctxCell.cellIndex
                            )
                        );
                        if (cellIndex > -1) throw new Error(
                            `duplicate context alias identifier: ${ctxCell.alias}`
                        );
                        else {
                            if (!_ctxAliases.find(
                                e => e.name === ctxCell.alias
                            )) _ctxAliases.push({
                                name: ctxCell.alias,
                                column: ctxCol.columnIndex,
                                row: ctxCell.cellIndex,
                                description: ctxCell.desc ?? ""
                            });
                        }
                    });
                });
            });
        });
        return _ctxAliases;
    }

    /**
     * @internal Checks if an import is deeper than 32 levels
     */
    private isDeepImport(imp: AST.Import): boolean {
        if (imp.sequence?.dotrain) {
            const _rd = imp.sequence.dotrain;
            if (_rd.problems.find(v => v.code === ErrorCode.DeepImport)) return true;
            else return false;
        }
        else return false;
    }

    /**
     * @internal Processes the configurations of an import asynchronously
     */
    private async processImportConfigs(imp: AST.Import, chunks: ParsedChunk[]) {
        const _reconfigProblems: AST.Problem[] = [];
        const _reconfigs: [ParsedChunk, ParsedChunk][] = [];
        for (let i = 0; i < chunks.length; i++) {
            if (chunks[i][0] === ".") {
                const _key = chunks[i];
                i++;
                if (chunks[i]) {
                    if (chunks[i][0] === "!") {
                        if (_reconfigs.find(v =>  
                            v[0][0] === _key[0] && 
                            v[1][0] === chunks[i][0]
                        )) _reconfigProblems.push({
                            msg: "duplicate statement",
                            position: [_key[1][0], chunks[i][1][1]],
                            code: ErrorCode.DuplicateImportStatement
                        });
                    }
                    else _reconfigProblems.push({
                        msg: "unexpected token",
                        position: chunks[i][1],
                        code: ErrorCode.UnexpectedToken
                    });
                }
                else _reconfigProblems.push({
                    msg: "expected elision syntax",
                    position: _key[1],
                    code: ErrorCode.ExpectedElisionOrRebinding
                });
                _reconfigs.push([_key, chunks[i]]);
            }
            else if (WORD_PATTERN.test(chunks[i][0])) {
                const _key = chunks[i];
                i++;
                if (chunks[i]) {
                    if (NUMERIC_PATTERN.test(chunks[i][0]) || chunks[i][0] === "!") {
                        if (_reconfigs.find(v => 
                            v[0][0] === _key[0] && 
                            v[1][0] === chunks[i][0]
                        )) _reconfigProblems.push({
                            msg: "duplicate statement",
                            position: [_key[1][0], chunks[i][1][1]],
                            code: ErrorCode.DuplicateImportStatement
                        });
                    }
                    else _reconfigProblems.push({
                        msg: "unexpected token",
                        position: chunks[i][1],
                        code: ErrorCode.UnexpectedToken
                    });
                }
                else _reconfigProblems.push({
                    msg: "expected rebinding or elision",
                    position: _key[1],
                    code: ErrorCode.ExpectedElisionOrRebinding
                });
                _reconfigs.push([_key, chunks[i]]);
            }
            else if (chunks[i][0].startsWith("'")) {
                const _key = chunks[i];
                if (WORD_PATTERN.test(_key[0].slice(1))) {
                    i++;
                    if (chunks[i]) {
                        if (WORD_PATTERN.test(chunks[i][0])) {
                            if (_reconfigs.find(v => 
                                v[0][0] === _key[0] && 
                                v[1][0] === chunks[i][0]
                            )) _reconfigProblems.push({
                                msg: "duplicate statement",
                                position: [_key[1][0], chunks[i][1][1]],
                                code: ErrorCode.DuplicateImportStatement
                            });
                        }
                        else _reconfigProblems.push({
                            msg: "invalid word pattern",
                            position: chunks[i][1],
                            code: ErrorCode.InvalidWordPattern
                        });
                    }
                    else _reconfigProblems.push({
                        msg: "expected name",
                        position: _key[1],
                        code: ErrorCode.ExpectedName
                    });
                }
                else {
                    _reconfigProblems.push({
                        msg: "invalid word pattern",
                        position: _key[1],
                        code: ErrorCode.InvalidWordPattern
                    });
                    i++;
                }
                _reconfigs.push([_key, chunks[i]]);
            }
            else {
                _reconfigProblems.push({
                    msg: "unexpected token",
                    position: chunks[i][1],
                    code: ErrorCode.UnexpectedToken
                });
                _reconfigs.push([chunks[i], chunks[++i]]);
            }
        }
        imp.reconfigs = _reconfigs;
        imp.reconfigProblems = _reconfigProblems;
    }

    /**
     * @internal Processes meta maps and stores them into the import instance
     */
    private async processMeta(imp: AST.Import, meta: Map<any, any>) {
        let _mn: Meta.MagicNumbers;
        try {
            _mn = meta.get(1);
            if (!Meta.MagicNumbers.is(_mn)) throw "";
        }
        catch {
            return Promise.reject();
        }
        if (!imp.sequence) imp.sequence = {};
        if (_mn === Meta.MagicNumbers.EXPRESSION_DEPLOYER_V2_BYTECODE_V1) {
            try {
                const _bytecode = Meta.decodeMap(meta);
                if (typeof _bytecode === "string") throw "";
                let _authoringMeta: Meta.Authoring[] = [];
                if (!this._ignoreAM) {
                    const _authoringMetaHash = (await execBytecode(
                        _bytecode,
                        NATIVE_PARSER_ABI,
                        "authoringMetaHash",
                        []
                    ))[0]?.toLowerCase();
                    let _authoringMetaBytes = await this.metaStore.getAuthoringMeta(
                        _authoringMetaHash,
                        "authoring-meta-hash"
                    );
                    if (!_authoringMetaBytes) _authoringMetaBytes = 
                        await this.metaStore.getAuthoringMeta(
                            await Meta.hash([meta], false),
                            "deployer-bytecode-hash"
                        );
                    if (!_authoringMetaBytes) {
                        if (!this._ignoreUAM) this.problems.push({
                            msg: "cannot find any settlement for authoring meta of specified dispair",
                            position: imp.hashPosition,
                            code: ErrorCode.UndefinedAuthoringMeta
                        });
                    }
                    else _authoringMeta = Meta.Authoring.abiDecode(_authoringMetaBytes);
                }
                imp.sequence.dispair = {
                    bytecode: hexlify(_bytecode, { allowMissingPrefix: true }),
                    authoringMeta: _authoringMeta
                };
            }
            catch (error) { return Promise.reject(); }
        }
        else if (_mn === Meta.MagicNumbers.CONTRACT_META_V1) {
            try {
                const _parsed = Meta.Contract.get(meta);
                imp.sequence.ctxmeta = this.toContextAlias(_parsed);
            }
            catch (error) { return Promise.reject(); }
        }
        else if (_mn === Meta.MagicNumbers.DOTRAIN_V1) {
            try {
                // const _str = String.fromCharCode(
                //     ...Meta.decodeMap(meta) as Uint8Array
                // );
                const _str = uint8ArrayToString(
                    Meta.decodeMap(meta) as Uint8Array
                );
                imp.sequence.dotrain = new RainDocument(
                    TextDocument.create(
                        `imported-dotrain-${imp.hash}`, 
                        "rainlang", 
                        0, 
                        _str as string
                    ),
                    this.metaStore,
                    this.importDepth + 1
                );
                await imp.sequence.dotrain.parse();
                if (imp.sequence.dotrain.problems.length) imp.problems.push({
                    msg: "imported rain document contains top level errors",
                    position: imp.hashPosition,
                    code: ErrorCode.InvalidRainDocument
                });
            }
            catch (error) { return Promise.reject(); }
        }
        else return Promise.reject();
        return Promise.resolve();
    }

    /**
     * @internal Handles an import statement
     */
    private async processImport(imp: ParsedChunk): Promise<AST.Import> {
        // let _record: string | null | undefined;
        let _metaPromise: Promise<void> | undefined;
        let _configPromise: Promise<void> | undefined;
        const _atPos: AST.Offsets = [imp[1][0] - 1, imp[1][0] - 1];
        // let _configChunks: ParsedChunk[] = [];
        const _result: AST.Import = {
            name: ".",
            hash: "",
            namePosition: _atPos,
            hashPosition: _atPos,
            problems: [],
            position: [imp[1][0] - 1, imp[1][1]]
        };

        const _chunks = exclusiveParse(imp[0], /\s+/gd, imp[1][0]);
        if (_chunks.length) {
            const _nameOrHash = _chunks.splice(0, 1)[0];
            if (!HEX_PATTERN.test(_nameOrHash[0])) {
                _result.name = _nameOrHash[0];
                _result.namePosition = _nameOrHash[1];
                if (!WORD_PATTERN.test(_nameOrHash[0])) _result.problems.push({
                    msg: "invalid word pattern",
                    position: _nameOrHash[1],
                    code: ErrorCode.InvalidWordPattern
                });
            }
            else {
                _result.name = ".";
                _result.namePosition = _nameOrHash[1];
                if (HASH_PATTERN.test(_nameOrHash[0])) {
                    _result.hash = _nameOrHash[0].toLowerCase();
                    _result.hashPosition = _nameOrHash[1];
                    _metaPromise = this.metaStore.update(_result.hash);
                    // if (this._shouldSearch) {
                    //     _metaPromise.then(() => _record = this.metaStore.getMeta(_result.hash));
                    // }
                }
                else _result.problems.push({
                    msg: "invalid hash, must be 32 bytes",
                    position: _nameOrHash[1],
                    code: ErrorCode.ExpectedHash
                });
            }
            if (_result.name !== ".") {
                if (_chunks.length) {
                    const _hash = _chunks.splice(0, 1)[0];
                    if (HEX_PATTERN.test(_hash[0])) {
                        if (!HASH_PATTERN.test(_hash[0])) _result.problems.push({
                            msg: "invalid hash, must be 32 bytes",
                            position: _hash[1],
                            code: ErrorCode.InvalidHash
                        });
                        else {
                            _result.hash = _hash[0].toLowerCase();
                            _result.hashPosition = _hash[1];
                            _metaPromise = this.metaStore.update(_result.hash);
                            // if (this._shouldSearch) {
                            //     _metaPromise.then(
                            //         () => _record = this.metaStore.getMeta(_result.hash)
                            //     );
                            // }
                        }
                    }
                    else _result.problems.push({
                        msg: "expected hash",
                        position: _hash[1],
                        code: ErrorCode.ExpectedHash
                    });
                }
                else {
                    _result.problems.push({
                        msg: "expected import hash",
                        position: _atPos,
                        code: ErrorCode.ExpectedHash
                    });
                }
            }
            _configPromise = this.processImportConfigs(_result, _chunks);
        }
        else _result.problems.push({
            msg: "expected a valid name or hash",
            position: _atPos,
            code: ErrorCode.InvalidImport
        });

        if (this._shouldSearch) await _metaPromise;
        const _record = this.metaStore.getMeta(_result.hash);

        if (_metaPromise !== undefined) {
            if (!_record) _result.problems.push({
                msg: `cannot find any settlement for hash: ${_result.hash}`,
                position: _result.hashPosition,
                code: ErrorCode.UndefinedMeta
            });
            else {
                let _metaMaps;
                try {
                    _metaMaps = Meta.decode(_record);
                }
                catch {
                    _metaMaps = undefined;
                }
                if (_metaMaps === undefined) _result.problems.push({
                    msg: "corrupt meta",
                    position: _result.hashPosition,
                    code: ErrorCode.CorruptMeta
                });
                else if (!isConsumableMeta(_metaMaps)) {
                    _result.problems.push({
                        msg: "inconsumable import",
                        position: _result.hashPosition,
                        code: ErrorCode.InconsumableMeta
                    });
                }
                else {
                    _result.sequence = {};
                    const _mm: Map<any, any>[] = [];
                    _mm.push(..._metaMaps.filter(v => 
                        v.get(1) === Meta.MagicNumbers.EXPRESSION_DEPLOYER_V2_BYTECODE_V1
                    ));
                    _mm.push(..._metaMaps.filter(
                        v => v.get(1) === Meta.MagicNumbers.CONTRACT_META_V1
                    ));
                    _mm.push(..._metaMaps.filter(
                        v => v.get(1) === Meta.MagicNumbers.DOTRAIN_V1
                    ));
                    try {
                        await Promise.all(
                            _mm.map(metamap => this.processMeta(_result, metamap))
                        );
                    }
                    catch {
                        _result.sequence = {};
                        _result.problems.push({
                            msg: "corrupt meta",
                            position: _result.hashPosition,
                            code: ErrorCode.CorruptMeta
                        });
                    }
                }
            }
        }
        await _configPromise;
        this.problems.push(..._result.problems, ...(_result.reconfigProblems ?? []));
        return _result as AST.Import;
    }

    /**
     * @internal 
     * The main workhorse of RainDocument which parses the words used in an
     * expression and is responsible for building the AST and collect problems
     */
    private async _parse() {
        this.authoringMeta      = [];
        this.imports            = [];
        this.problems           = [];
        this.comments           = [];
        this.bindings           = [];
        this.namespace          = {};
        this.authoringMetaPath  = "";
        this.bytecode           = "";
        this._ignoreAM          = false;
        this._ignoreUAM         = false;
        this.runtimeError       = undefined;
        let document            = this.textDocument.getText();

        // parse comments
        inclusiveParse(document, /\/\*[^]*?(?:\*\/|$)/gd).forEach(v => {
            if (!v[0].endsWith("*/")) this.problems.push({
                msg: "unexpected end of comment",
                position: v[1],
                code: ErrorCode.UnexpectedEndOfComment
            });
            this.comments.push({
                comment: v[0],
                position: v[1]
            });
            document = fillIn(document, v[1]);
        });

        // search for the actionable comments
        if (this.comments.find(v => /\bignore-authoring-meta\b/.test(v.comment))) 
            this._ignoreAM = true;
        if (this.comments.find(v => /\bignore-undefined-authoring-meta\b/.test(v.comment))) 
            this._ignoreUAM = true;
        if (this._ignoreAM) this._ignoreUAM = true;

        const _importStatements = exclusiveParse(document, /@/gd, undefined, true).slice(1);
        for (let i = 0; i < _importStatements.length; i++) {
            // filter out irrevelant parts
            const _index = _importStatements[i][0].indexOf("#");
            if (_index > -1) {
                _importStatements[i][0] = _importStatements[i][0].slice(0, _index);
                _importStatements[i][1][1] = _importStatements[i][1][0] + _index - 1;
            }
            document = fillIn(
                document, 
                [_importStatements[i][1][0] - 1, _importStatements[i][1][1]]
            );
        }
        if (this.importDepth < 32) (await Promise.all(
            _importStatements.map(importStatement => this.processImport(importStatement))
        )).forEach(imp => {
            if (imp.hash && this.imports.find(v => v.hash === imp.hash)) {
                imp.problems.push({
                    msg: "duplicate import",
                    position: imp.hashPosition,
                    code: ErrorCode.DuplicateImport
                });
                this.problems.push({
                    msg: "duplicate import",
                    position: imp.hashPosition,
                    code: ErrorCode.DuplicateImport
                });
            }
            this.imports.push(imp);
        });
        else _importStatements.forEach(imp => this.problems.push({
            msg: "import too deep",
            position: [imp[1][0] - 1, imp[1][1]],
            code: ErrorCode.DeepImport
        }));

        for (let i = 0; i < this.imports.length; i++) {
            if (this.imports[i].problems.length === 0) {
                const _imp = this.imports[i];
                if (this.namespace[_imp.name] && "Element" in this.namespace[_imp.name]) {
                    this.problems.push({
                        msg: `cannot import into "${_imp.name}", name already taken`,
                        position: _imp.namePosition,
                        code: ErrorCode.InvalidImport
                    });
                }
                else {
                    if (this.isDeepImport(_imp)) this.problems.push({
                        msg: "import too deep",
                        position: _imp.hashPosition,
                        code: ErrorCode.DeepImport
                    });
                    else {
                        let _hasDupKeys = false;
                        let _hasDupWords = false;
                        let _ns: AST.Namespace = {};
                        if (_imp.sequence?.dispair?.authoringMeta) {
                            _ns["Words"] = {
                                Hash: _imp.hash,
                                ImportIndex: i,
                                Element: _imp.sequence.dispair.authoringMeta
                            };
                            (_ns["Words"] as any).bytecode = _imp.sequence.dispair.bytecode;
                            _imp.sequence.dispair.authoringMeta.forEach(
                                v => _ns[v.word] = {
                                    Hash: _imp.hash,
                                    ImportIndex: i,
                                    Element: v
                                }
                            );
                        }
                        if (_imp.sequence?.ctxmeta) {
                            if (
                                hasDuplicate(
                                    _imp.sequence.ctxmeta.map(v => v.name), 
                                    Object.keys(_ns)
                                )
                            ) _hasDupKeys = true;
                            else _imp.sequence.ctxmeta.forEach(v => {
                                _ns[v.name] = {
                                    Hash: _imp.hash,
                                    ImportIndex: i,
                                    Element: v
                                };
                            });
                        }
                        if (_imp.sequence?.dotrain) {
                            if (!_hasDupKeys) {
                                if (_imp.sequence.dotrain) {
                                    const _keys = Object.keys(
                                        _imp.sequence.dotrain.namespace
                                    );
                                    if (_ns["Words"] && _keys.includes("Words")) _hasDupWords = true;
                                    else {
                                        if(hasDuplicate(_keys,Object.keys(_ns))) _hasDupKeys = true;
                                        else _ns = {
                                            ..._ns,
                                            ...this.copyNamespace(
                                                _imp.sequence.dotrain.namespace,
                                                i,
                                                _imp.hash
                                            )
                                        };
                                    }
                                }
                            }
                        }
                        if (_hasDupKeys || _hasDupWords) {
                            if (_hasDupKeys) this.problems.push({
                                msg: "import contains items with duplicate identifiers",
                                position: _imp.hashPosition,
                                code: ErrorCode.DuplicateIdentifier
                            });
                            else this.problems.push({
                                msg: "import contains multiple sets of words in its namespace",
                                position: _imp.hashPosition,
                                code: ErrorCode.MultipleWords
                            });
                        }
                        else {
                            if (_imp.reconfigs) for (let j = 0; j < _imp.reconfigs.length; j++) {
                                const _s: [ParsedChunk, ParsedChunk] = _imp.reconfigs[j];
                                if (_s[0] !== undefined && _s[1] !== undefined) {
                                    if (_s[1][0] === "!") {
                                        if (_s[0][0] === ".") {
                                            if (_ns["Words"]) {
                                                (_ns["Words"].Element as Meta.Authoring[]).forEach(v => {
                                                    delete _ns[v.word];
                                                });
                                                delete _ns["Words"];
                                            }
                                            else this.problems.push({
                                                msg: "cannot elide undefined words",
                                                position: [_s[0][1][0], _s[1][1][1]],
                                                code: ErrorCode.UndefinedDISpair
                                            });
                                        }
                                        else {
                                            if (_ns[_s[0][0]]) {
                                                if (AST.Namespace.isWord(_ns[_s[0][0]])) {
                                                    this.problems.push({
                                                        msg: `cannot elide single word: "${_s[0][0]}"`,
                                                        position: [_s[0][1][0], _s[1][1][1]],
                                                        code: ErrorCode.SingleWordModify
                                                    });
                                                }
                                                else delete _ns[_s[0][0]];
                                            }
                                            else this.problems.push({
                                                msg: `undefined identifier "${_s[0][0]}"`,
                                                position: _s[0][1],
                                                code: ErrorCode.UndefinedIdentifier
                                            });
                                        }
                                    }
                                    else {
                                        const _key = _s[0][0].startsWith("'") 
                                            ? _s[0][0].slice(1) 
                                            : _s[0][0];
                                        if (_ns[_key]) {
                                            if (AST.Namespace.isWord(_ns[_key])) {
                                                this.problems.push({
                                                    msg: `cannot rename or rebind single word: "${_s[0][0]}"`,
                                                    position: [_s[0][1][0], _s[1][1][1]],
                                                    code: ErrorCode.SingleWordModify
                                                });
                                            }
                                            else {
                                                if (_s[0][0].startsWith("'")) {
                                                    if (_ns[_s[1][0]]) this.problems.push({
                                                        msg: `cannot rename, name "${_s[1][0]}" already exists`,
                                                        position: _s[1][1],
                                                        code: ErrorCode.DuplicateIdentifier
                                                    });
                                                    else {
                                                        _ns[_s[1][0]] = _ns[_key];
                                                        delete _ns[_key];
                                                    }
                                                }
                                                else {
                                                    if (!AST.Namespace.isBinding(_ns[_key])) {
                                                        this.problems.push({
                                                            msg: "unexpected rebinding",
                                                            position: [_s[0][1][0], _s[1][1][1]],
                                                            code: ErrorCode.UnexpectedRebinding
                                                        });
                                                    }
                                                    else {
                                                        (_ns[_key].Element as AST.Binding)
                                                            .constant = _s[1][0];
                                                            
                                                        // eslint-disable-next-line max-len
                                                        if ((_ns[_key].Element as AST.Binding).elided) {
                                                            delete (
                                                                _ns[_key].Element as AST.Binding
                                                            ).elided;
                                                        }
                                                        if((_ns[_key].Element as AST.Binding).exp) {
                                                            delete (
                                                                _ns[_key].Element as AST.Binding
                                                            ).exp;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        else this.problems.push({
                                            msg: `undefined identifier "${_key}"`,
                                            position: _s[0][1],
                                            code: ErrorCode.UndefinedIdentifier
                                        });
                                    }
                                }
                            }
                        }
                        this.mergeNamespace(_imp, _ns);
                    }
                }
            }
        }

        // parse bindings
        exclusiveParse(document, /#/gd, undefined, true).slice(1).forEach((v) => {
            // if (i > 0) {
            const _index = v[0].search(/\s/);
            const position = v[1];
            let name: string;
            let namePosition: AST.Offsets;
            let content: string;
            let contentPosition: AST.Offsets;
            let elided: string;
            let _invalidId = false;
            let _dupId = false;
            let _noCmContent: string;
            if (_index === -1) {
                name = v[0];
                namePosition = v[1];
                contentPosition = [v[1][1] + 1, v[1][1]];
                content = "";
                _noCmContent = "";
            }
            else {
                const _noCmTrimmed = trackedTrim(v[0].slice(_index + 1));
                _noCmContent = !_noCmTrimmed.text ? v[0].slice(_index + 1) : _noCmTrimmed.text;

                const _contentText = this.textDocument.getText(
                    Range.create(
                        this.textDocument.positionAt(v[1][0]),
                        this.textDocument.positionAt(v[1][1] + 1)
                    )
                );
                const _trimmed = trackedTrim(_contentText.slice(_index + 1));
                name = v[0].slice(0, _index);
                namePosition = [v[1][0], v[1][0] + _index - 1];
                content = !_trimmed.text ? _contentText.slice(_index + 1) : _trimmed.text;
                contentPosition = !_trimmed.text
                    ? [v[1][0] + _index + 1, v[1][1]]
                    : [
                        v[1][0] + _index + 1 + _trimmed.startDelCount, 
                        v[1][1] - _trimmed.endDelCount
                    ];
            }
            if (_invalidId = !name.match(/^[a-z][a-z0-9-]*$/)) this.problems.push({
                msg: "invalid binding name",
                position: namePosition,
                code: ErrorCode.InvalidBindingIdentifier
            });
            if (_dupId = Object.keys(this.namespace).includes(name)) this.problems.push({
                msg: "duplicate identifier",
                position: namePosition,
                code: ErrorCode.DuplicateIdentifier
            });
            if (!_noCmContent || _noCmContent.match(/^\s+$/)) this.problems.push({
                msg: "empty binding are not allowed",
                position: namePosition,
                code: ErrorCode.InvalidEmptyBinding
            });

            if (!_invalidId && !_dupId) {
                if (this.isElided(_noCmContent)) {
                    const _msg = _noCmContent.trim().slice(1).trim();
                    if (_msg) elided = _msg;
                    else elided = DEFAULT_ELISION;
                    this.namespace[name] = {
                        Hash: "",
                        ImportIndex: -1,
                        Element: {
                            name,
                            namePosition,
                            content,
                            contentPosition,
                            position,
                            problems: [],
                            // [{
                            //     msg: _msg,
                            //     position: namePosition,
                            //     code: ErrorCode.ElidedBinding
                            // }],
                            dependencies: [],
                            elided
                        }
                    };
                }
                else {
                    const _val = this.isConstant(_noCmContent);
                    if (_val) {
                        this.namespace[name] = {
                            Hash: "",
                            ImportIndex: -1,
                            Element: {
                                name,
                                namePosition,
                                content,
                                contentPosition,
                                position,
                                problems: [],
                                dependencies: [],
                                constant: _val
                            }
                        };
                    }
                    else this.namespace[name] = {
                        Hash: "",
                        ImportIndex: -1,
                        Element: {
                            name,
                            namePosition,
                            content,
                            contentPosition,
                            position,
                            problems: [],
                            dependencies: [],
                        }
                    };
                }
                this.bindings.push(this.namespace[name].Element as AST.Binding);
            }
            document = fillIn(document, [v[1][0] - 1, v[1][1]]);
        });

        // find non-top level imports
        if (this.bindings.length > 0) this.imports.forEach(v => {
            if (v.position[0] >= this.bindings[0].namePosition[0]) this.problems.push({
                msg: "imports can only be stated at top level",
                position: [...v.position],
                code: ErrorCode.InvalidImport
            });
        });

        // find any remaining strings and include them as errors
        exclusiveParse(document, /\s+/).forEach(v => {
            this.problems.push({
                msg: "unexpected token",
                position: v[1],
                code: ErrorCode.UnexpectedToken
            });
        });

        // resolve dependencies and parse expressions
        this.processDependencies();

        // instantiate rainlang for each expression
        if (this.importDepth === 0) {

            // assign working words for this instance
            this.getWords();

            this.bindings.forEach(v => {
                if (v.constant === undefined && v.elided === undefined) {
                    v.exp = new Rainlang(
                        v.content, 
                        this.authoringMeta, 
                        // this.bytecode,
                        "0",
                        {
                            // thisBinding: v,
                            namespaces: this.namespace,
                            ignoreAuthoringMeta: this._ignoreUAM
                            // comments: this.comments.filter(e => 
                            //     e.position[0] >= v.contentPosition[0] && 
                            //     e.position[1] <= v.contentPosition[1]
                            // ).map(e => {
                            //     return {
                            //         comment: e.comment,
                            //         position: [
                            //             e.position[0] - v.contentPosition[0],
                            //             e.position[1] - v.contentPosition[0]
                            //         ]
                            //     };
                            // })
                        }
                    );
                    v.problems.push(
                        ...(v.exp as any).problems.map((e: any) => ({
                            msg: e.msg,
                            position: [
                                e.position[0] + v.contentPosition[0],
                                e.position[1] + v.contentPosition[0]
                            ],
                            code: e.code,
                        }))
                    );
                }
            });
        }

        // ignore next line problems
        this.comments.forEach(v => {
            if (/\bignore-next-line\b/.test(v.comment)) {
                const _cmLine = this.textDocument.positionAt(v.position[1] + 1).line;
                let _index;
                while (
                    (_index = this.problems.findIndex(
                        e => this.textDocument.positionAt(e.position[0]).line === _cmLine + 1
                    )) > -1
                ) this.problems.splice(_index, 1);
            }
        });
    }

    /**
     * @public Resolves the expressions dependencies and instantiates RainlangParser for them
     */
    private processDependencies() {
        const _bindings = this.bindings.filter(
            v => v.constant === undefined && v.elided === undefined
        );
        let _edges: [string, string][] = [];
        let _nodes = _bindings.map(v => v.name);
        const regexp = /'\.?[a-z][0-9a-z-]*(\.[a-z][0-9a-z-]*)*/g;
        for (let i = 0; i < _nodes.length; i++) {
            Array.from(
                _bindings[i].content.matchAll(regexp)
            ).map(
                v => v[0]
            ).forEach(v => {
                _bindings[i].dependencies.push(v.slice(1));
                _edges.push([_nodes[i], v.slice(1)]);
            });
        }

        while (!_nodes.length || !_edges.length) {
            try {
                toposort.array(_nodes, _edges).reverse();
                break;
            }
            catch (error: any) {
                if (error instanceof Error && error.message.includes("Cyclic dependency")) {
                    const errorExp = error.message.slice(error.message.indexOf("\"") + 1, -1);
                    if (!errorExp.includes(" ")) {
                        const nodesToDelete = [errorExp];
                        for (let i = 0; i < nodesToDelete.length; i++) {
                            _edges.forEach(v => {
                                if (v[1] === nodesToDelete[i]) {
                                    if (!nodesToDelete.includes(v[0])) nodesToDelete.push(v[0]);
                                }
                            });
                        }
                        _edges = _edges.filter(
                            v => !nodesToDelete.includes(v[1]) || !nodesToDelete.includes(v[0])
                        );
                        _nodes = _nodes.filter(v => !nodesToDelete.includes(v));
                        for (let i = 0; i < nodesToDelete.length; i++) {
                            const _b = _bindings.find(
                                v => v.name === nodesToDelete[i]
                            );
                            _b?.problems.push({
                                msg: "circular dependency",
                                position: _b.namePosition,
                                code: ErrorCode.CircularDependency
                            });
                        }
                    }
                }
                else {
                    this.problems.push({
                        msg: "cannot resolve dependencies",
                        position: [0, -1],
                        code: ErrorCode.UnresolvableDependencies
                    });
                    break;
                }
            }
        }
    }

    /**
     * @internal Checks if a text contains a single numeric value and returns it
     * @returns The numeric value if present, and an empty string if false
     */
    private isConstant(text: string): string {
        const _items = exclusiveParse(text, /\s+/gd);
        if (_items.length !== 1) return "";
        else {
            if (NUMERIC_PATTERN.test(_items[0][0])) {
                if (/^[1-9]\d*e\d+$/.test(_items[0][0])) {
                    const _index = _items[0][0].indexOf("e");
                    return _items[0][0].slice(0, _index)
                        + "0".repeat(Number(_items[0][0].slice(_index + 1)));
                }
                else {
                    if (/^0x[0-9a-zA-Z]+$/.test(_items[0][0])) return _items[0][0];
                    else return BigInt(_items[0][0]).toString();
                }
            }
            else return "";
        }
    }

    /**
     * @internal Checks if a binding is elided
     */
    private isElided(text: string): boolean {
        return text.trim().startsWith("!");
    }

    /**
     * @internal Method to copy Namespaces
     */
    private copyNamespace(ns: AST.Namespace, index: number, hash: string): AST.Namespace {
        const _ns: AST.Namespace = {};
        const _keys = Object.keys(ns);
        for (let i = 0; i < _keys.length; i++) {
            if ("Element" in ns[_keys[i]]) _ns[_keys[i]] = {
                Hash: ns[_keys[i]].Hash ? ns[_keys[i]].Hash as string : hash,
                ImportIndex: index,
                Element: ns[
                    _keys[i]
                ].Element as Meta.Authoring | Meta.Authoring[] | AST.Binding | AST.ContextAlias
            };
            else _ns[_keys[i]] = this.copyNamespace(ns[_keys[i]] as AST.Namespace, index, hash);
        }
        return _ns;
    }

    private mergeNamespace(imp: AST.Import, ns: AST.Namespace): boolean {
        if (imp.name !== "." && this.namespace[imp.name] === undefined) 
            this.namespace[imp.name] = {};
        const _mns = imp.name === "." 
            ? this.namespace 
            : this.namespace[imp.name] as AST.Namespace;
        const _check = (nns: AST.Namespace, cns: AST.Namespace): string => {
            const _cKeys = Object.keys(cns);
            if (!_cKeys.length) return "ok";
            else {
                if (_cKeys.includes("Element")) return "cannot import into an occupied namespace";
                else {
                    let _dupWords = false;
                    const _nKeys = Object.keys(nns);
                    if (_cKeys.includes("Words")) {
                        if (nns["Words"]) {
                            if (nns["Words"].Hash !== cns["Words"].Hash) {
                                return "namespace already contains a set of words";
                            }
                            else _dupWords = true;
                        }
                    }
                    for (let i = 0; i < _nKeys.length; i++) {
                        for (let j = 0; j < _cKeys.length; j++) {
                            if (_nKeys[i] === _cKeys[j]) {
                                if (!("Element" in nns[_nKeys[i]]) && !("Element" in cns[_cKeys[j]])) {
                                    const _result = _check(
                                        nns[_nKeys[i]] as AST.Namespace, 
                                        cns[_cKeys[j]] as AST.Namespace
                                    );
                                    if (_result !== "ok") return _result;
                                }
                                else if (
                                    AST.Namespace.isNode(nns[_nKeys[i]]) && 
                                    AST.Namespace.isNode(cns[_cKeys[j]])
                                ) {
                                    if (
                                        !AST.Namespace.isWord(nns[_nKeys[i]]) || 
                                        !AST.Namespace.isWord(cns[_cKeys[j]])
                                    ) {
                                        if (
                                            (
                                                AST.Namespace.isBinding(nns[_nKeys[i]]) && 
                                                AST.Namespace.isBinding(cns[_cKeys[j]])
                                            ) || (
                                                AST.Namespace.isContextAlias(nns[_nKeys[i]]) && 
                                                AST.Namespace.isContextAlias(cns[_cKeys[j]])
                                            )
                                        ) {
                                            if (nns[_nKeys[i]].Hash !== cns[_cKeys[j]].Hash) {
                                                return "duplicate identifier";
                                            }
                                        }
                                        else return "duplicate identifier";
                                    }
                                    else {
                                        if (!_dupWords) return "namespace already contains a set of words";
                                    }
                                }
                                else return "cannot import into an occupied namespace";
                            }
                        }
                    }
                    return "ok";
                }
            }
        };
        const _isOk = _check(ns, _mns);
        if (_isOk !== "ok") {
            this.problems.push({
                msg: _isOk,
                position: imp.hashPosition,
                code: _isOk.includes("identifier") 
                    ? ErrorCode.DuplicateIdentifier
                    : _isOk.includes("words")
                        ? ErrorCode.MultipleWords
                        : ErrorCode.InvalidImport
            });
            if (imp.name !== "." && !Object.keys(this.namespace[imp.name]).length) 
                delete this.namespace[imp.name];
            return false;
        }
        else {
            const _merge = (nns: AST.Namespace, cns: AST.Namespace) => {
                const _cKeys = Object.keys(cns);
                const _nKeys = Object.keys(nns);
                if (!_cKeys.length) {
                    for (let i = 0; i < _nKeys.length; i++) cns[_nKeys[i]] = nns[_nKeys[i]];
                }
                else {
                    for (let i = 0; i < _nKeys.length; i++) {
                        if (!_cKeys.includes(_nKeys[i])) cns[_nKeys[i]] = nns[_nKeys[i]];
                        else {
                            if (!("Element" in nns[_nKeys[i]])) _merge(
                                nns[_nKeys[i]] as AST.Namespace,
                                cns[_nKeys[i]] as AST.Namespace
                            );
                        }
                    }
                }
            };
            _merge(ns, _mns);
            return true;
        }
    }

    /**
     * @internal Method to assign working words for this instance and store its path
     */
    private getWords() {
        const _validate = (ns: AST.Namespace, hash: string): [number, string] => {
            let _c = 0;
            // let _h: string;
            if (ns["Words"]) {
                if (hash === "") {
                    _c++;
                    hash = ns["Words"].Hash as string;
                }
                else if ((ns["Words"].Hash as string).toLowerCase() !== hash.toLowerCase()) {
                    return [++_c, hash];
                }
            }
            const _nns = Object.values(ns).filter(v => !v.Element) as AST.Namespace[];
            for (let i = 0; i < _nns.length; i++) {
                const _temp = _validate(_nns[i], hash);
                hash = _temp[1];
                _c += _temp[0];
                if (_c > 1) break;
            }
            return [_c, hash];
        };
        const _wordsCount = _validate(this.namespace, "")[0];
        if (_wordsCount > 1) this.problems.push({
            msg: `words must be singleton, but namespaces include ${_wordsCount} sets of words`,
            position: [0, -1],
            code: ErrorCode.SingletonWords
        });
        else if (_wordsCount === 0) this.problems.push({
            msg: "cannot find any set of words",
            position: [0, -1],
            code: ErrorCode.UndefinedDISpair
        });
        else {
            const _get = (ns: AST.Namespace, path: string): string => {
                if (ns["Words"]) {
                    this.authoringMeta = ns["Words"].Element as Meta.Authoring[];
                    this.bytecode = (ns["Words"] as any).bytecode as string;
                    return path;
                }
                else {
                    const _nns = Object.entries(ns).filter(v => !v[1].Element);
                    for (let i = 0; i < _nns.length; i++) {
                        const _p = _get(_nns[i][1] as AST.Namespace, _nns[i][0]);
                        if (_p) return path + "." + _p;
                    }
                    return "";
                }
            };
            if (this.authoringMetaPath) { /* empty */ }
            const _path = _get(this.namespace, "");
            if (!_path) this.authoringMetaPath = ".";
            else this.authoringMetaPath = _path;
        }
    }
}

// Meta.Store.create(
//     {records: {
//         "0x78fd1edb0bdb928db6015990fecafbb964b44692e2d435693062dd4efc6254dd": "0xa3005944b2608060405234801561001057600080fd5b50600436106100be5760003560e01c8063c19423bc11610076578063f0cfdd371161005b578063f0cfdd37146101ec578063fab4087a14610213578063ffc257041461023457600080fd5b8063c19423bc1461018b578063cbb7d173146101d757600080fd5b80638d614591116100a75780638d61459114610135578063a600bd0a1461014a578063b6c7175a1461015d57600080fd5b806301ffc9a7146100c357806331a66b65146100eb575b600080fd5b6100d66100d1366004613d18565b61023c565b60405190151581526020015b60405180910390f35b6100fe6100f9366004613f2e565b6102d5565b6040805173ffffffffffffffffffffffffffffffffffffffff948516815292841660208401529216918101919091526060016100e2565b61013d61047c565b6040516100e29190614024565b61013d610158366004614037565b61048b565b6040517fa4d558de3cab056effa790499ea313ff3d962d95513646614a9a29073f44aeb181526020016100e2565b6101b27f000000000000000000000000000000000000000000000000000000000000000081565b60405173ffffffffffffffffffffffffffffffffffffffff90911681526020016100e2565b6101ea6101e5366004613f2e565b610547565b005b6101b27f000000000000000000000000000000000000000000000000000000000000000081565b610226610221366004614037565b610570565b6040516100e29291906140a7565b61013d61058d565b60007fffffffff0000000000000000000000000000000000000000000000000000000082167f31a66b650000000000000000000000000000000000000000000000000000000014806102cf57507fffffffff0000000000000000000000000000000000000000000000000000000082167f01ffc9a700000000000000000000000000000000000000000000000000000000145b92915050565b60008060006102e5868686610547565b7f4a48f556905d90b4a58742999556994182322843167010b59bf8149724db51cf3387878760405161031a94939291906140d5565b60405180910390a18451865160009182916103bd916020020160400160408051602c83017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01681019091527effff0000000000000000000000000000000000000000000000000000000000600190920160e81b919091167f61000080600c6000396000f3000000000000000000000000000000000000000017815290600d820190565b915091506103cc8189896105ae565b60006103d7836105ec565b6040805133815273ffffffffffffffffffffffffffffffffffffffff831660208201529192507fce6e4a4a7b561c65155990775d2faf8a581292f97859ce67e366fd53686b31f1910160405180910390a17f000000000000000000000000000000000000000000000000000000000000000095507f00000000000000000000000000000000000000000000000000000000000000009450925050505b93509350939050565b606061048661065a565b905090565b805160208201206060907fa4d558de3cab056effa790499ea313ff3d962d95513646614a9a29073f44aeb1811461051c576040517f26cc0fec0000000000000000000000000000000000000000000000000000000081527fa4d558de3cab056effa790499ea313ff3d962d95513646614a9a29073f44aeb16004820152602481018290526044015b60405180910390fd5b6000838060200190518101906105329190614135565b905061053f816002610837565b949350505050565b61056b60405180608001604052806052815260200161437160529139848484610b64565b505050565b6060806105848361057f61058d565b610f23565b91509150915091565b606060405180610120016040528060ef81526020016143c360ef9139905090565b80600182510160200281015b808210156105d55781518552602094850194909101906105ba565b505061056b6105e18390565b84845160200161178b565b6000806000600d9050835160e81c61ffff168101846000f0915073ffffffffffffffffffffffffffffffffffffffff8216610653576040517f08d4abb600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5092915050565b6060613d0e60006029905080915060006040518061054001604052808467ffffffffffffffff1667ffffffffffffffff1681526020016117f1815260200161186b81526020016118d281526020016118dc81526020016118d281526020016118d281526020016118d281526020016118d281526020016118d281526020016118e681526020016119088152602001611932815260200161195481526020016118e681526020016119548152602001611954815260200161195e8152602001611968815260200161195481526020016119548152602001611971815260200161197181526020016119548152602001611968815260200161196881526020016119718152602001611971815260200161197181526020016119718152602001611971815260200161197181526020016119718152602001611971815260200161197181526020016119718152602001611971815260200161197181526020016119688152602001611988815260200161199281526020016119928152509050606081905060298151146108255780516040517fc8b56901000000000000000000000000000000000000000000000000000000008152600481019190915260248101849052604401610513565b61082e816119a1565b94505050505090565b6060808060008060ff861667ffffffffffffffff81111561085a5761085a613d61565b604051908082528060200260200182016040528015610883578160200160208202803683370190505b5093508560ff1667ffffffffffffffff8111156108a2576108a2613d61565b6040519080825280602002602001820160405280156108cb578160200160208202803683370190505b509250865b805115610940576000806108e383611a32565b8951909550919350915082908890869081106109015761090161429b565b602002602001019060ff16908160ff1681525050808685815181106109285761092861429b565b602090810291909101015250506001909101906108d0565b5060006005885102602183026001010190508067ffffffffffffffff81111561096b5761096b613d61565b6040519080825280601f01601f191660200182016040528015610995576020820181803683370190505b50955081602087015360005b828110156109d357806021026021880101816020026020018701518153602080830287010151600191820152016109a1565b50506021028401600601905060005b8651811015610b5a576000805b6000806000878581518110610a0657610a0661429b565b60200260200101519050600080610a568b8881518110610a2857610a2861429b565b602002602001015160ff168f8a81518110610a4557610a4561429b565b602002602001015160000151611b60565b925090506005600087610a8c7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff85018716611b82565b01919091028a01805190955062ffffff84811693501690508015610b0157818103610ae3576040517f59293c5100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600190970196610af284611b82565b870196505050505050506109ef565b8195505050505060188b8681518110610b1c57610b1c61429b565b60200260200101516020015160ff16901b602086901b17821791506000600160056001901b03199050828183511617825250505050506001016109e2565b5050505092915050565b6000610b6f84611c5b565b90508082511115610bb95781516040517ffd9e1af4000000000000000000000000000000000000000000000000000000008152600481019190915260248101829052604401610513565b6020850160005b82811015610f1a576000610bd48783611c79565b90506000610be28884611c92565b90508551831015610cb2578115610c2f576040517fee8d10810000000000000000000000000000000000000000000000000000000081526004810184905260248101839052604401610513565b858381518110610c4157610c4161429b565b6020026020010151811015610cb2578281878581518110610c6457610c6461429b565b60200260200101516040517ff7dd619f000000000000000000000000000000000000000000000000000000008152600401610513939291909283526020830191909152604082015260600190565b6000610cc089848a51611cab565b905060006018610cd08b87611d17565b0390506000610cdf8b87611d48565b600402820190505b80821015610e64578151601c81901a60020288015162ffffff821691601d1a9060f01c600080610d15888685565b91509150838214610d695760808801516040517fddf5607100000000000000000000000000000000000000000000000000000000815260048101919091526024810183905260448101859052606401610513565b8751821115610dbb57608088015188516040517f2cab6bff0000000000000000000000000000000000000000000000000000000081526004810192909252602482015260448101839052606401610513565b875182900380895260408901511115610e1d57608088015188516040808b015190517f1bc5ab0f000000000000000000000000000000000000000000000000000000008152600481019390935260248301919091526044820152606401610513565b8751810180895260208901511015610e3757875160208901525b6001811115610e4857875160408901525b5050506080850180516001019052505060049190910190610ce7565b610e6e8b87611d61565b836020015114610ec2578260200151610e878c88611d61565b6040517f4d9c18dc00000000000000000000000000000000000000000000000000000000815260048101929092526024820152604401610513565b82518414610f095782516040517f4689f0b3000000000000000000000000000000000000000000000000000000008152600481019190915260248101859052604401610513565b505060019093019250610bc0915050565b50505050505050565b6060806000610f30611d7a565b85519091501561176c578451600090602087810191880101825b818310156116c9576001835160001a1b905060018560e001511660000361125b576f07fffffe8000000000000000000000008116156111035760e085015160021615610feb578883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517f5520a51700000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b6f07fffffe0000000000000000000000008116156110975761101d836f07fffffe0000000003ff200000000000611ee9565b9450925060008061102e8787611f9a565b915091508115611090576040517f53e6feba0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08c8703016004820152602401610513565b50506110b8565b6110b560018401836f07fffffe0000000003ff200000000000612011565b92505b604085018051600190810190915260a086018051909101905260e0850180516022177fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffef169052610f4a565b640100002600811615611154576111236001840183640100002600612011565b60e0860180517ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd1690529250610f4a565b67040000000000000081161561119d5760e0850180516021177fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed16905260019290920191610f4a565b658000000000008116156112315760108560e0015116600003611215578883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517fedad0c5800000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b61121f898461203d565b60e08601805160021790529250610f4a565b8883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe001610fb6565b6f07fffffe0000000000000000000000008116156113f05760e0850151600216156112db578883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517f4e803df600000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b6112f5836f07fffffe0000000003ff200000000000611ee9565b8095508194505050600080613d0e6113138b896101a0015189612149565b92509250925082156113565760006113358961018001518e898563ffffffff16565b9097509050611345898483612215565b5060e08801805160041790526113dd565b6113608888612352565b909350915082156113855761137788600084612215565b611380886123cd565b6113dd565b6040517f81bd48db0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08d8803016004820152602401610513565b50505060e0850180516002179052610f4a565b60e0850151600416156114e657650100000000008116600003611465576040517f23b5c6ea0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08a8503016004820152602401610513565b60608501805160001a60030190819053603b8111156114b0576040517f6232f2d900000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5060e0850180517ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9169052600190920191610f4a565b650200000000008116156115b7576000606086015160001a905080600003611560576040517f7f9db5420000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08b8603016004820152602401610513565b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd01606086018181538160048201015160001a8260028301015160f01c60010153506115ab866123cd565b50600190920191610f4a565b6401000026008116156115d7576111236001840183640100002600612011565b6703ff00000000000081161561160d576115f2858a85612430565b92506115fd856123cd565b60e0850180516002179052610f4a565b6510000000000081161561163157611626858a85612582565b600190920191610f4a565b6708000000000000008116156116675761164c858a85612582565b61165585612855565b601860e0860152600190920191610f4a565b6580000000000081161561169f578883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0016111e0565b8883037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0016112a6565b818314611702576040517f7d565df600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60e085015160201615611767576040517ff06f54cf0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08a8503016004820152602401610513565b505050505b61177581612a97565b61177e82612bcf565b92509250505b9250929050565b6020810680820384015b808510156117b0578451845260209485019490930192611795565b5080156117eb577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff600882021c808451168119865116178452505b50505050565b815160009081908390811061184957608085015185516040517feaa16f330000000000000000000000000000000000000000000000000000000081526004810192909252602482015260448101829052606401610513565b846040015181111561185d57604085018190525b506000946001945092505050565b600080836060015183106118c557608084015160608501516040517feb7894540000000000000000000000000000000000000000000000000000000081526004810192909252602482015260448101849052606401610513565b5060009360019350915050565b5060009160019150565b60101c9160019150565b600080601083901c806118fa5760016118fc565b805b95600195509350505050565b600080601083901c8061191c57600261191e565b805b905060028106156118fa57806001016118fc565b600080601083901c80611946576001611948565b805b95600095509350505050565b5060029160019150565b5060039160019150565b50600191829150565b600080601083901c600181116118fa5760026118fc565b5060029160009150565b60046001808316019250929050565b60606000825160020267ffffffffffffffff8111156119c2576119c2613d61565b6040519080825280601f01601f1916602001820160405280156119ec576020820181803683370190505b50905061ffff80196020850160208651028101600285015b81831015611a2657805183518616908516178152602090920191600201611a04565b50939695505050505050565b60008060606000805b60ff811015611ab3576000805b8751811015611a7a57600080611a6a858b8581518110610a4557610a4561429b565b5093909317925050600101611a48565b506000611a8682611b82565b905083811115611a9a578093508296508195505b87518103611aa9575050611ab3565b5050600101611a3b565b5084516040805192909103808352600101602002820190529050600080805b8651811015611b5657600080611af78860ff168a8581518110610a4557610a4561429b565b91509150848216600003611b0e5793811793611b4c565b888381518110611b2057611b2061429b565b6020026020010151868581518110611b3a57611b3a61429b565b60209081029190910101526001909301925b5050600101611ad2565b5050509193909250565b60008082600052836020536021600020905060018160001a1b91509250929050565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203611bb45750610100919050565b507f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f7f5555555555555555555555555555555555555555555555555555555555555555600183901c16909103600281901c7f3333333333333333333333333333333333333333333333333333333333333333908116911601600481901c01167f01010101010101010101010101010101010101010101010101010101010101010260f81c90565b60008151600003611c6e57506000919050565b506020015160001a90565b600080611c868484611d17565b5160021a949350505050565b600080611c9f8484611d17565b5160031a949350505050565b611ce46040518060c001604052806000815260200160008152602001600081526020016000815260200160008152602001606081525090565b506040805160c081018252838152602081018490529081019290925260608201526000608082015260a081019190915290565b600080611d2384611c5b565b60020260010190506000611d378585612c44565b949091019093016020019392505050565b600080611d558484611d17565b5160001a949350505050565b600080611d6e8484611d17565b5160011a949350505050565b611df3604051806101e001604052806000815260200160008152602001600081526020016000815260200160008152602001600081526020016000815260200160008152602001600081526020016000815260200160008152602001600081526020016000815260200160008152602001600081525090565b6000604051806101e00160405280600081526020016000815260200160008152602001600081526020016000815260200160008152602001600081526020016010600817815260200160008152602001600081526020016000815260200160008152602001611e6861333c60101b6130901790565b8152602001611e92613a7360401b61390260301b6137a660201b61369860101b6135fb1717171790565b8152600060209182018190526040805183815280840182528452918301819052908201819052606082018190526080820181905260a08201819052610100820181905261012082018190526101c082015292915050565b8151600090819060015b8419600183831a1b1615602082101615611f0f57600101611ef3565b9485019460208190036008810292831c90921b91611f9157604080516020810184905201604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0818403018152908290527fe47fe8b700000000000000000000000000000000000000000000000000000000825261051391600401614024565b50939492505050565b600080611fa78484612352565b90925090508161178457506101008301805160408051948552602080862092865285018152909401517fffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000909416601085901b62ff000016179092179091529160ff90911660010190565b60005b6000826001865160001a1b1611838510161561203557600184019350612014565b509192915050565b805160009060f01c612f2a81146120a6576040517f3e47169c0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0858503016004820152602401610513565b835160029390930192602a90602f90860160200160005b80612103575b81871084885160001a141516156120df576001870196506120c3565b6001870196508187101583885160001a1417156120fe57506001958601955b6120bd565b508086111561213e576040517f7d565df600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b509395945050505050565b600183810180516000928392613d0e92602160ff909116028801600681019201845b81831015612201576001830151602190930180519093600090819060ff168180612195838f611b60565b915091506000876121aa600185038916611b82565b016005028b015195505062ffffff90811693508416830391506121ec9050575060019850601b81901a9750601c1a8a901c61ffff169550610473945050505050565b6121f583611b82565b8401935050505061216b565b506000998a99508998509650505050505050565b61221e83612cbc565b60e08301805160207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff79190911681179091528301516021600091821a850101805190911a600101815350825180516060850151600090811a86016061018051929361ffff85169360088504909103601c0192600191901a018153600060038201537fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe30180517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00001690911790528451602090920183821b176018820185901b179182905260e081900361234b578451604080518088526020601084901b81178252810190915281517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000161790525b5050505050565b61010082015161012083015160008381526020808220919384939290911c91600160ff84161b808216156123b85761ffff83165b80156123b6578360201c85036123a9576001965061ffff8460101c1695506123b6565b51925061ffff8316612386565b505b17610120909601959095525090939092509050565b6000606082015160001a90508060000361242c5760208201805160001a600101908181535080603f0361056b576040517fa25cba3100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050565b6000613d0e600080600061244a8861018001518888612d06565b8981038a206101408d015194985092965090945092507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000016906001600083811a82901b929091908316156124f0576101608c015160101c5b80156124ee5780517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000811686036124dd5760019350506124ee565b505160019091019061ffff166124a2565b505b6101608c015161ffff1661251660018461250a578261250e565b8383035b8f9190612215565b508161257257604080518082019091526101608d015160101c8517815260006125448d8a8a63ffffffff8e16565b6020830152506101608d018051600161ffff9091160160109290921b9190911790526101408c018051841790525b50929a9950505050505050505050565b606083015160001a80156125e8576040517f6fb11cdc0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0848403016004820152602401610513565b506125f283612cbc565b60e083018051603060089182161790915260a0840151602085015160ff8083169360f89290921c9290911c16810360008190036126bb5760088660e0015116600003612690576040517fab1d3ea70000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b90820160f881901b60208701526101c08601519091906126b09084612fc9565b6101c0870152612784565b60018111156127845780831015612724576040517f78ef27820000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b80831115612784576040517f43168e680000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b8082036001016020601083028101905b818110156128405760a08901516020848b01015190821c61ffff169060001a60015b81811161282f5760208306601c036127cf57915160f01c915b82516101c08d015160019190911a906127e89082613011565b6101c08e015261281982841480156128005750886001145b61280b57600161280d565b8a5b6101c08f015190613058565b6101c08e015250600492909201916001016127b6565b505060019093019250601001612794565b5050505060081b60a090940193909352505050565b60c0810151602082015160f082811c9160001a600101908290036128a5576040517fa806284100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600080856101c001519050855161ffff815160101c165b80156128d357805190915060101c61ffff166128bc565b50604051602188018051919450601c830192916004916024870191600090811a805b8a8310156129bb5760048202860195506004878903045b8082111561292a57965161ffff16601c81019850969003600761290c565b506004810297889003805186529794909401938103865b6007821115612986575160101c61ffff1680518652601c909501947ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff990910190612941565b81156129a1575160101c61ffff168051865260048202909501945b505050600191820180519092919091019060001a806128f5565b50505050818652600486019350846001600484040360181b1763ffffffff19855116178452601f19601f820116604052505050506001846001901b612a0091906142f9565b851682851b60f0612a1287601061430c565b901b171760c087015260e0860180517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdf16905260408051602080825280820183529088526000908801819052908701819052606087018190526080870181905260a08701819052610100870181905261012087018190526101c0870152505050505050565b60c08101518151516060919060f082901c9060208114612ae3576040517f858f2dcf00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b604051935060208401601083046000818353506001600885048301810192839101600080805b88811015612b425789811c61ffff81165163ffff0000601092831b16811760e01b8786015284019360f08390031b929092179101612b09565b50825117909152878203017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08181018952908801601f011660405260005b82811015612bc3576002810288016003015161ffff90811683018051602060f082901c019260e09190911c1690612bb883828461178b565b505050600101612b80565b50505050505050919050565b6101608101516040805161ffff8316808252602080820283019081019093529092909160109190911c90835b80821115612c3b5760208301518252915161ffff16917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe090910190612bfb565b50505050919050565b6002810282016003015161ffff166000612c5d84611c5b565b845190915060056002830284010190811180612c795750818410155b15612cb45784846040517fd3fc97bd00000000000000000000000000000000000000000000000000000000815260040161051392919061431f565b505092915050565b60208101805160001a6001810182015160001a61056b578251805160a085018051600861ffff939093169290920460200390920160106001601e84901a860301021b179052505050565b8051613d0e9060009081908190600181831a1b6703ff000000000000811615612f2857600182811a1b7ffffffffffffffffffffffffffffffffffeffffffffffffffffff00000000000082821701612de25760028801806c7e0000007e03ff0000000000005b806001835160001a1b1615612d8657600182019150612d6c565b508a5161ffff8d16908c0160200180831115612dce576040517f7d565df600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5098509096509450849350612fc092505050565b876001810160006703ff0000000000006c200000002000000000000000005b816001855160001a1b1615612e1b57600184019350612e01565b806001855160001a1b1615612e4c57600184019392505b816001855160001a1b1615612e4c57600184019350612e32565b50508015801590612e6b575080600301821180612e6b57508060010182145b15612ec8576040517f013b2aaa0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08d8303016004820152602401610513565b8b5161ffff60108f901c16908d0160200180841115612f13576040517f7d565df600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5099509197509550859450612fc09350505050565b87518801602001808810612f68576040517f7d565df600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6040517fb0e4e5b30000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08a8a03016004820152602401610513565b93509350935093565b6000612fd58383613058565b9250507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ff821660ff600884811c919091168301901b1792915050565b600060ff831682811015613051576040517f04671d0000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050900390565b600060ff808416830190600885901c16601085901c808311156130785750815b601081901b600883901b841717935050505092915050565b600082820360408111156130f6576040517fff2f59490000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b80600003613156576040517fc75cd5090000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b600281066001036131b9576040517fd76d9b570000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff830160005b858210613332578151600090811a906001821b906703ff00000000000082161561322c57507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd082016132fc565b6c7e00000000000000000000000082161561326a57507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa982016132fc565b687e00000000000000008216156132a457507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc982016132fc565b6040517f69f1e3e60000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08b8703016004820152602401610513565b831b959095179450507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff909101906004016131df565b5050509392505050565b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd8101516000908190603090829080821a87870360038111801561339157506001821b6c200000002000000000000000001615155b156133b357600488039550600a858460011a0302858460021a0301935061345f565b8260011a91506002811180156133da57506001821b6c200000002000000000000000001615155b156133f257600388039550848360021a03935061345f565b8015613407576001880395506000935061345f565b6040517ffa65827e0000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08b8b03016004820152602401610513565b5050505b8583101580156134735750604d81105b156134b857825160001a829003600a82900a0293909301927fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff90920191600101613463565b85831061333257825160001a829003600181111561352b578784037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517f8f2b5ffd00000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b600a82900a8102858101861115613566578885037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0016134f6565b9490940193507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff909201915b85831061333257825160001a603081146135d0578784037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0016134f6565b507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff90920191613592565b80516000908190600190821a1b7ffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000008101613687576040517ff8216c550000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0868603016004820152602401610513565b83600092509250505b935093915050565b815181516000918291600190831a1b9085016020017ffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000008201613798576136e76001860182640100002600612011565b945060006136f9888861ffff89613c11565b909650905061370e8683640100002600612011565b8051909650600160009190911a1b92506740000000000000008314613788578686037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517f722cd24a00000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b6001860194509250613690915050565b846000935093505050613690565b815181516000918291600190831a1b9085016020017ffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000082016138a7576137f56001860182640100002600612011565b94506000613806888860ff89613c11565b90965090508061381c8784640100002600612011565b9650600061382d8a8a60ff8b613c11565b909850600881901b9290921791905061384c8885640100002600612011565b8051909850600160009190911a1b94506740000000000000008514613895578888037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe001613753565b50600187019550935061369092505050565b8585037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015b6040517f24027dc400000000000000000000000000000000000000000000000000000000815260040161051391815260200190565b815181516000918291600190831a1b9085016020017ffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000008201613798576139516001860182640100002600612011565b80519095506001600091821a1b92507fffffffffffffffffffffffffffffffffffffffffffffffffc000000000000000830161398f575060006139b4565b61399c8888600189613c11565b90965090506139b18683640100002600612011565b95505b85516001600091821a1b93507fffffffffffffffffffffffffffffffffffffffffffffffffc00000000000000084016139ef57506000613a14565b6139fc898960018a613c11565b9097509050613a118784640100002600612011565b96505b8651600160009190911a81901b945081901b82176740000000000000008514613a61578888037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe001613753565b60018801965094506136909350505050565b815181516000918291600190831a1b9085016020017ffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000082016138a757613ac26001860182640100002600612011565b94506000613ad3888860ff89613c11565b9096509050613ae88683640100002600612011565b80519096506001600091821a1b93507fffffffffffffffffffffffffffffffffffffffffffffffffc0000000000000008401613b2657506000613b4b565b613b33898960018a613c11565b9097509050613b488784640100002600612011565b96505b86516001600091821a1b94507fffffffffffffffffffffffffffffffffffffffffffffffffc0000000000000008501613b8657506000613bab565b613b938a8a60018b613c11565b9098509050613ba88885640100002600612011565b97505b8751600160009190911a1b9450600882901b8317600982901b176740000000000000008614613bfe578989037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe001613753565b6001890197509550613690945050505050565b80516000908190600190821a1b7fffffffffffffffffffffffffffffffffffffffffffffffffc0000000000000008101613c6f578584037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0016138cd565b613d0e6000806000613c828b8b8a612d06565b93509350935093506000613c9b8b85858863ffffffff16565b905089811115613cfd576040517f7480c7840000000000000000000000000000000000000000000000000000000081527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08c8b03016004820152602401610513565b909b909a5098505050505050505050565b613d16614341565b565b600060208284031215613d2a57600080fd5b81357fffffffff0000000000000000000000000000000000000000000000000000000081168114613d5a57600080fd5b9392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b6040516060810167ffffffffffffffff81118282101715613db357613db3613d61565b60405290565b604051601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe016810167ffffffffffffffff81118282101715613e0057613e00613d61565b604052919050565b600067ffffffffffffffff821115613e2257613e22613d61565b50601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200190565b600082601f830112613e5f57600080fd5b8135613e72613e6d82613e08565b613db9565b818152846020838601011115613e8757600080fd5b816020850160208301376000918101602001919091529392505050565b600067ffffffffffffffff821115613ebe57613ebe613d61565b5060051b60200190565b600082601f830112613ed957600080fd5b81356020613ee9613e6d83613ea4565b82815260059290921b84018101918181019086841115613f0857600080fd5b8286015b84811015613f235780358352918301918301613f0c565b509695505050505050565b600080600060608486031215613f4357600080fd5b833567ffffffffffffffff80821115613f5b57600080fd5b613f6787838801613e4e565b94506020860135915080821115613f7d57600080fd5b613f8987838801613ec8565b93506040860135915080821115613f9f57600080fd5b50613fac86828701613ec8565b9150509250925092565b60005b83811015613fd1578181015183820152602001613fb9565b50506000910152565b60008151808452613ff2816020860160208601613fb6565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b602081526000613d5a6020830184613fda565b60006020828403121561404957600080fd5b813567ffffffffffffffff81111561406057600080fd5b61053f84828501613e4e565b600081518084526020808501945080840160005b8381101561409c57815187529582019590820190600101614080565b509495945050505050565b6040815260006140ba6040830185613fda565b82810360208401526140cc818561406c565b95945050505050565b73ffffffffffffffffffffffffffffffffffffffff851681526080602082015260006141046080830186613fda565b8281036040840152614116818661406c565b9050828103606084015261412a818561406c565b979650505050505050565b6000602080838503121561414857600080fd5b825167ffffffffffffffff8082111561416057600080fd5b818501915085601f83011261417457600080fd5b8151614182613e6d82613ea4565b81815260059190911b830184019084810190888311156141a157600080fd5b8585015b8381101561428e578051858111156141bd5760008081fd5b86016060818c037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0018113156141f35760008081fd5b6141fb613d90565b89830151815260408084015160ff811681146142175760008081fd5b828c015291830151918883111561422e5760008081fd5b82840193508d603f85011261424557600092508283fd5b8a8401519250614257613e6d84613e08565b8381528e8285870101111561426c5760008081fd5b61427b848d8301848801613fb6565b90820152855250509186019186016141a5565b5098975050505050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b818103818111156102cf576102cf6142ca565b808201808211156102cf576102cf6142ca565b6040815260006143326040830185613fda565b90508260208301529392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052605160045260246000fdfe17f1186b18d218dc18d218d218d218d218d218e619081932195418e619541954195e196819541954197119711954196819681971197119711971197119711971197119711971197119711968198819921992010f00c20804b001180500014014144080040101008082020092020040a100148024163082aae700108f616d2200e3c6181b0025fdfc2100a1cef21c00e7762b2500229a7e0b103e260a0600ce656d0220f12be70c0035f0270900da2bcc14001874cb0700319e1e2300c17cd61100d0684c05007c4b951f000859681e00ce62340d0021f48512009046c219008710c503002c340815002eaa701740b3357a1a00e6d3420800f0dfe2040080a95b0e004e5b480a107012321840438b4b24008a3266281043e2f6011056328a1d00ec53cd0f006e69fa1000ac8cde2600f2c1681300b8577627103fa0c82000c6ff51011bffdb988a8cd04d320278186170706c69636174696f6e2f6f637465742d73747265616d",
//         // "0x11b9c1d11469bbe1034986e499732102eb817ae1ca851895a3d2ff2ea3161b84": "0xff0a89c674ee7874a5005904e7dd5a4b6fdb3810fe2b85cfb96cb7bb87de92d8450cc47561375b608b60c188239b0845121415db5bf4bf77f4b25eb4ac9705a317c39638f3cd83339c19fafb8f09132a30fee4237e75a4a7a40091fc64c28016847f3d28987c9c104a35f8fee4662288173e88de2b0df8890f4d71d5cf9bf30c7c233534227d3918c8117a60484617bffcf97c53a6f28d0e1cf36e457292cef62a0461524c417179007d2f45bc109fe177976d322027fd9d4099407188a07c430c2c02435e1867e680ef84148a1cc80bcfa9e4a4bca54ed43a1adba6e19fef3368d82b700cd0929eb8e4947df2d4c43101e116dae7e392dbc06ca56662b3406b3e107fbb60be478cb3cda840ebb38207f8fbfd5f7f67d0f4805f98f308626372bcd27516e92b2cd0b882124d97ca3fc92653e48ed0a91db393fc52cd05857d37c91dc29d80e3d6a0f318b11397d05b8ea470924741f9a58ad735d03ea39b12b1e1e8fcb50cb4037d4de6ba3e985a39a7e0308ff047869c085fbe8176b9dc351516c38e3968d54f287118c9c8bfa7c811d1b281dc29f4e3c37a6ec0eb0b2b8c3e28898f7b6c3219189bbfdbb0f09858c65c6ab59f1dc55d5808ba5920c96b19eb8e4112a7b87a36764d30fd8bcd353892895a3fdaa4ff2cc5bfa06514f1978fdad9dec1c332d9fa7d3ddf186f35225ebc191fc1355f8806311ee452612214f4f2800fb06f937507c15c10ee4aed01bd979e87a1b236448fb05d8fb068e4a8909db20deb9db1da0067c66e78b42dc83e3e82c79032ce7c788812be068f5d1ef1b334b78e03ca206cb998b914e692d238a336f4c530a071340f1561bd4ad0b0e720a25f7d90325901a1f58a0766e9dec94050ffde4a33be015008e7f56b7f166d745f57096ac33e3a6c5a56c148e383ce81b63372a9874e7b8c4a1fddc43c51c63a65df4ce238b3c5557667b9edcec1bcd9c3bfa9f2b79c4b2ceeb1f3afd72344ccd60ed428477a0ca04493423ed22059d848fc32e91524b6bef66ad09b97b47e42b03611da82e8ca6d15d13fb0cd76470ae3bdb396b2d05ceacc7d120e97fea8c57b0a395af1fe24d27e39a9a43be4fcea5c70a916d5096a713a9807cee6a3e9a8701029ee92fc5564582bcb3c1be4daa92fef076c86efb76494ed0d7d5ac5d2711f9bfc8b8c56f913cbf0bc025b5d7c795557e35b778519ab4bfe186e57afc37b90b1f7f3ab903bf14dea5192981f282575183d714316316b858b29281eda253c7705c993b739cc50b335fb1f1a9edcdf340a368b565cdc1ce1fc2eeecd92a1f89890f54d31c14bac832703047609f7e1a628079613782195bd3a73bd076151303971bfd78e174d2eeb86e1c6cedf5cb654b5ee26b39655294d4bdbc95cb88f98af1561f95dfa16560557ed3c38deb95af81526a3c9b2db2387ab55b255375dcb2909d7efcf96114e25a87155379635173e21cfdcc80e76338bbf320f58b227295f25235d7249d5e8e4b49f93d52b7615e4a3cc0d445494b62c84f2b2d604da4bc0388d462ec9c2730a9d54e782cab41fe2b4dc66836dab38811776568d415132a3b19e7a37cf55fcfffc613371cdbf46ac5ca262ab35ab4aeab067b266ff0ab1fb3ab3159b17cea781ed6415f38dc1ae8580ebe4bc6b2b5a13e37796eff7099690d5062bd2c3fd169cd7829d87f05ecafd53b230d7e80d9de486f01b25b5895a8539ba9fe88dbc77ca67dd327b49feab3b633e94aa6597e0c09ffe5782fd907744d2e4f9f374fd1985a4e4567dc2e7ed76d3f32f011bffe5ffb4a3ff2cde02706170706c69636174696f6e2f6a736f6e03676465666c6174650462656ea40059077ddd5a5b6f1c3514de3c94bba05cca4d15b8dc9240769b0d2aad84841242814a944a6de10541c73be3ddb53233deda9e6c9617507f03af48f90f48bcd29fd29fc2b13db3e3bd8d6776671bb57e49329fc773ce778ecf393e4ea3782007be5d0c9f73bc7fee5131fecc6931feac037fce2bc69f6f3870c7fa2f38d67f71df813f2ac65f7a588cbfecf8fe2ba7c5f879c7fbafee17e3afa162fcf562b8f1860b7f588c5ff8b3187fd32bc6df72bcfff66931feee7e317e1115e3ef15c38df71d3872ac7fc9817fb05f8c7fe878ffa386037f548c7ffcb018ffc4816f3ad6df72e09f361cb8e3fdcf1c780b0989fda3c6d2e3bc03f71cf8d6211b5022108e1139a142d2b8878e719810d4e52c42b24f8c84ad450bf82c8609b1ac2cb919abcabf99c98f324152f1592c5909f195fc929c2c2bbe33ff790ebc37967f8af554ae16ba0b7f74291712b101e1380e1015f60cf81926518c1422083c9c99c0d970b1fe7d2cfa1575ae323c07fed5f7f07da57f18221a0f1229e007580e2301ae1812f4f91eea8c2449e949d45374447c1f1fed5df902d4ea84cc3f6ac649d421fc0ce47f4799c74f3827e0795a166464c918f7fb98c64d1aac41b632f25db0e5d3b2201ad8de10e1932630ded4fc3e7ef9be54f2810c344a22346042d00e183d667133263d2ce93151fe407a841b0f68a1bddfc0f0a889daadb1fc01f16984c3f6b5fab570c97f3857fef63594ca045bf7840480d02c32b5603f26bd7e38020dda57c8d5abadc20f18ff96342210c8a2416d8aa5c373e01767fd7b2c8b161cc7a3ba65aa22dff53c3c2aa7f99d70962580042266d70a2c3b8871b48b68179163c247e6a98a95bb45165001954a0ac96529f957cc6f1b1b7739c13a28ead888051a60ca8754e8f06e24bb6c145680b0f30510a2f9184fdc142937a0742248d04237ba302b9f001fe0247b6f4727117232e004dc9ac5882bde64fa892c19f9503974885e4e49a7ea08ce81689f050441200f68b74b94f7500c51bc43e4909018454928e92024f6a72134e97c8d23fbab2d07812416095f7ecbaf5a7ffc77db90a2dc0ab682ed54e820cf698a5682218ac1b627ca064046a0d485e78672e5af6aeae36697dc4f70d8946c690657e36fb3ad999b624ac9b4037b95298694b32ff602bd976b157962780efc40592bc4d66e73469f2937717ca0a7f63fe14dd9c7714d3ad9c373e087da3e721c53c682a772212597f1acb4f654134ada4e0d5bbf26e3cd9afdd1a5dfad52fa81e9b45c283b5394d795766bd264fef01c787263ae761321ded6264f0db7329dcc24d9a77c660e2c0ebfcf04369b052a74523e2bfd2f8ded9b6fb90aded968841028d7b5f91a6ef9f717f9a792abcce61bcbbf86cd5542fe1fdcf2afb0b960e4b57f408febd3abac7e0fbea1c734206246c5ce48077f2dbc55bdd9c701eb9460ce8c026dd1161c1036594c3615496dd2beb6dd42d755ce1f9718a02715401ae06a67391c38e707aa82ba58c987e7c04f6f9a5a844e9ef125eb11cdccea9428e2d38287fa58153b50dff88404c626d9d9cca4e5ada9b3d7762be747f83824ca8f46318ea85f4effddd5f8d9d8b8a3be3ad5ff112c2213b4649c6811d53e997fc0b48bfff146d35b2a7bcffca23fa2ca4b7bbb9999468a6ca659500ea13a1d2866e17369652a747789b3509d66a1c884ae8c6e406199706304a83007c4572778a05b9d5bc0dade0cdb9e2bfecebc51ce2ed9d877e05e31bcf16b669f3865b466334df5f4e618cacc4eadb495d9613b3f22183b88dc10437dacd8455b01e962d819db0612286043d3276c674f92416a629ddd8b56b72c3bbb3e31bb113006e5783764c3f433e95b8a4089ac568d69d4b466eddbac986757b5ef2f05f65dd0c551d6519637a1dd468cd17e2c6f5fc99e72eb42fd07bd451cacabfde9cc3fc70741b030f3cc6b338ae9dc02c2d3ca59251720f7efb5b0e0d2ffaf22fd6bc8bc2bb263fc632d955b397e828af59bd365aa56684a7fe8c7d4a7f1e4f01cf8e96d0c95f5acfa692d3e6043503f6d6454e622ed1f8203e906958e2e2c0983d4594af98ae207e69c153f07dfd278ae579b1acaea5b2de2c3f101ab3e5f87969e03bf5741bf65c285f6ef88aee9f45ccd7e345eaffdd6a1a5e7c0ef55d06f79fbb133cbdfc14d1624213bdbf8bc9693b3199e037fe03e3f970ac32b9c908b0554fc88a453171fd3c373e07fdc493a92635f4ed033fe2f0adb63ca5225d215f374054759a04f5da160347e3dad71adf3cb3a5870e9ff7725fd6b28f8aab103fd7db2f4ffd6d4c1cfd7df1139dd5d918c43c7bae094764446aa000a193b4a060eff1767ab5fff8ead1fd8a0b47620f8740f686a62de0b2272210b494cc5100f9ac77b4d1cc1b153362ba5c155efc7ff3d64113837994c81461255b766d5ec11dc1383a7de4f28578527433da53eea81afc6d67473099bcd373914fd6454fc794f5fb1c3ad875af3b23d15320a277e7e833ede7f4068d60553cbab47e96ae6ec0d1b6961d3ae0b20e32375c452b7b53b73ba750b049fb8b111d6ed871176bc6066fe2e4bb8ec675327144be7eaab1e695d4cabf0a01fe8bb4ff52f21465f4e7db0850f7dfd1ef03ca41093e0fe9a136814c4e60e7b48c2b055e43ff0fdc7e73fff4cfa4f9a0a1739041899802983cc33a6dd67c2db9e20efb1e57e929c07c6ff011bffe9e3a02ca8e23502706170706c69636174696f6e2f63626f7203676465666c617465",
//         "0x56ffc3fc82109c33f1e1544157a70144fc15e7c6e9ae9c65a636fd165b1bc51c": "0xff0a89c674ee7874a4005910f6789cc55adb72db46127df7574cf945498a922c2771a55c9bad22256697655b4c49b2b3deaccb1a0243724a20c06000d1dc54def783f68bf64bf674f7cc0020a95b6c272f1249cca5bba7fbf4e91efcfa48a9c7b95e98c7cfd5e371999a520d8ae2ea718f7ed7137bda7ed43c498d4be8e77eae0a7a32c11355cd75a552b3cc8ab553ae2a756566d638559a65699cc92b932aed94c58712bfe0af321fe891b3458e61ba9ae327ac92634c6aaf6d5aeb4cd67707ea626ee4b3e2cd9222c70e49a56ce54c36551333d7d7d8ccd985cd7499ad555528ac343c3bfee6d9d367ea5ad759a52675a556b69aab459de04f511a35b5b951b352e35f2aab16d8f41afbcc8b1516b932904d63a0ceb222d1ac449e62ee353eb12e399eacd5043bce8d2d55b1ca21708f47d15e05f6d4f99ad64eccb252c554edb93956747bd08ad6f753d4abfe5bb25fe16c1567a7a55ef985bd2c754e46d0e5c4c200e5da6b363a71aac895564b53eef34835d1ce420e4cceb12ceb29c69493724b93d8e9baad2629054b562b8329bc2e544f12ccb2f9cc1bb439323993e63b0ebaaa4bb2965ae80f76512f945e14752eca68d904265bd6d5218c827f74e6b650d3b2589098243b84aa2ca48095aa70e207ea27d2a15a151d8761e33b8cef895b7933f19a7264b482cdaf69142d68340ebd202ff356f16a27506b87ea074afd2b573f14e4a67ab1cc4c8fced05932bf78625f9c895552172f4efbaca9d70ddf07f25cf3bc4ae74161c872f4e4c9f323b2a0757e3128605d91d1805ccda1510e7b4f6c662bf6651650043e50a3291d85cc1b28bd5c1a8d63ed0a33d810a6ef8fa111e13984f0862031ac13f799c2a438c10ac6e215bdaed8d50f4c34ec497379d595cd32918ecf31080591839168dfa3608f1d83fbcde0c101d97c346e9fa2ce569a1085fdd506108156cfbd72ac17061e7d073f4fec02a831b51f307059c047709a596d3c826c382607021dffc4c48866af49eab20462a9248365350297ad93b9423953f958f722b702008261addbc4109fba582f6dc2a8e10392cd92177e3fb59233216f9673c0e6f0c1a4c20c9c1aedc342d26048901b933ab2e152afd54ccbc7b24820158fe3350ed490dd9f65e6fd66d024ac4ac3c4312c19244b6a3822e09425c14f69812f221c6c6039384b36ca7bc2ca4c2fdf07d3f993f37ed5487965cc52e449ed748ad9b02afb545103ce26e41337c5195cd95d110475bdf7e809f67495d16974e78f74d2add118d0d261cf79b47d98478fbc21b4c090778ad2e28062e4d1e1c3906b4135e32a56d7454993a2ce52c95848714b3a327d65e276a92d0d1fe4147095cc8d461c6f64d4eb22bb161b62cf1202e8b25a937029dca7a7c6318fbb7ab92c4a827ebfacda6bf6727b6a6190d452899d55515ec5a4cb1942ed2d7479454152aff7b6744fd7201b3669070dd214cc215ed3235fa344bb7248f30df608943587269e9817f93e9b4b73ce80f69d642501e489c81a905f6a7e544c819e9265163ad733b340a4f710b33aa3c78c7938cbbcda2feb3cc74f3df56af8a6a74c951cb07dff6dca627fc6c19e4a04ed8b5b46b4f0610ec56706a91d4800fbebd2520ae013a2817c1858a1655c78c2739e7a797949ff78d9befa1e6604d0f5d5a11a33e4f5e3c3417838880f07ad995f35a3be088b7c15267c89295fc415bf8ad3bfa405c2cf7f8debc71f07f14796e37ffff9efd6767ff91ef1e1f5e089d1bbe0eb9723b0b2af8fbe7df643a6ddfca5214273090f875bb3857cd27ca2a6065145635456900f1338d061498e246f2357c111080b5399fda5b629254c8945767fd0ae39d89d3a19fec330340aa4ea9926f068f1d716b738507d44b5e762f0ce400393b2709407b2c88e283f5d6b78ff24337cb42c2f89cb1ca3f9caec6e305467c31ffba3133578ab8efb2f5f8e4effa62efa2f866a7c76323c43e841320eac6830600eacd2f000f0ddb0394c8944531a0e20e4240e739891fd1fce6e1a66d5883129cab25811a93a87752fff095f1e7e88f49e4f64e0875cb242ccf918972980992d126649e4c3ae4b0e3f273ebf034516447ed9ecf9bacbfe84109646388f9bdb658f770cdbb96211108e727420acf8a8cb12a90ee28055c1f08e6063c50889444e881cf86ac294db066ecacbf3b2c38bbf7bf6551a426fc94c9449456972c789cd7555206a33f28dac60b8c2a62252abc209bc31b38864ed40111c971a96aa89b44efcead6b95a982d2b1e4802e039258191a18106b5231c60924f94d1e3ec5e919b3df5fafce4824ebd2cead91c70677ea10a097acae393fea8c7fb06970fc985bca264248797bc3f7a1ad006a22cf42cb7559d9af7de1c96d44934c46856e5a03d3247df5dc64880605d99f0fcd96524a8b15a0b31cf91cae8eb4b90c2978a1d4aef4b48ae55de1bb080829305a21aec8908c37bd68ff5224a92ef11535d322962d4c8eb8529bb53e8f475d70b7140f5924a469ba71b87813dafa181800069014a5e33dc5816baa495b9b480a4269ed76a0eca95e9240239f8170a582941fcda2ed620b2251e51402419acdf942f90daa6c48033eb2a5f4652c60b9c8cd147e8ab1c83e75b7181b63ddf3353246f91dd56e62e9a0c37686298b90d13395d570570d3b356ac8f0fa25c2b93cb0ab0eb94680aaa926ccd7138e72a5b7bd064b24428be51c7788b49a8ecad9080677b5150bf740cdf684166a72ca7a7458da108295159c75282aa046fb7181098b09a5bae74b084b19c31326294b079ee7345cb6d191a98a74d688c806c51b6ca01aee5d975841f6311942fe22f0beb623384168d8e41f0a6ab4a27571ef4247349bb63cd685473db44385b734227e3e1b93a1d5fe048204f5c4f705f42358041886a14721ec03d5e12938940ef33299db3d0b9a4c8428cc49e0b997270c04a23933f7da218a93448a52fd2c44df02bd510241e47ceb6845c9f63cb29478e08ca792416fcdeee42f8a4e8a09c7b3a5617e317c353f56afc66f86a787a71dec3fc6c1d3b32a1e1a333e26392a8eb65cafd9bd6dea17cf4192914fe4d8156498a70927001f1545491c5886007a960391a4d471a2de83d1474d04d4903763f2a20f575615327c9c0d7ec2592078d4cc052192859e65eb35854833928e334afb5303aa0e6d970d03f673a41763957fdd393f0f1a7d1c5dfd5c9dbd3feabd1b11af45ff64f8f87aa7f36e493397ffde38fe3b38be149dbadc6a72fdfaa9fc6672fced5e8076f693ff19c6712e0f2b2fd9393d1c5687c7a78fe7a7071d63fa6cfea47509937fdd72f2fe2f1f0a19ed4e05b69cd55155258ce6cdc806b9079a4c89fc23a75e9dabd1fe19c54b9fbd487d40847a2c8269b767b05e171bd3c1086da3edd889a4d5381e1be148a872294c1dedc0864c5a657357cad49767e65100e22986a5a931b218a0893500958c75d062419500be6309cebc30ed2b8f3cb63434fa3622f10c7de13a791b2eada68dfc608a5556b0deff7545bfa754cda8457445e7663e650d67930e16688f708a6488420be68820d6d262744584785133de058c7af8b8648509c9829e0c0522f2556b33bda9d5cd87ac0e27c2d86964a20c819283b8de7746e174602ab81df50ee09a01362d95c3c6ee2cb7866ea9d42911245bbadd977ada62a19f0b206ac3cfd16fcc67b46034450cf84ead3e64873a8179050b1126de389baa0ebda1f8d2b9aee09b24386e299b830536bd6cbdbd9431fff92a6241de709ea732bf2387024b2401b0f7ce9dc702c289d6aebe08073e97087beb1e5cc475274a0afc9b0dee4b18bba734c93a6d8ad860d1770f06e94d6aca3c6312d81f05ca4b45ca047a69819cf639835334ce728e3f8c8a461ebf397b78177cae844afcf2fa4823a265c2257a7d60b82baf4f48b7b00220c6f31cb8a09437bab9af39d7b365bcf3302264c64f0949aaf703b4f30a0c31c45526036a20ffd42b927741da0d521750aafcc9a1cda052ad8ed9e538858aa3d425b729a990fd6d77a6c65ba27482591067963cbd05f2d748875300ba199f009c63f986355da06d9c820ade370c25dd3e612a3cb3770b4a74515486fd3460c2d5917b956fb728776168e6f4aeff41e3124a52ea9c917ca666e7e8293d5cbca5b56ae52229f633ecb7840ccabb58fdb95104d2b99b18ba02aab17a6611c3257e835f60628ac371fee793bf5485e9016c058518bafce6a223b018f9af42df919e60284ec6aa8e5ed72a7e93e9775ce9737787c391a3512bc39bae4ed5aa761cd66d3c1b728f9447adbb5290d9e424206bad040512fde1e1f2ecc6202f371d94dbcee8a5b5d29ca8ed24eb8e6412cc002c9155595eb094638df05a33ffe8e30b3dad155604c80f2bb431a4ff8ea705e554bf7fcf07086b3ab2707a8ab0fe9b60d741f4b17197fd90fdf64b2741869d99ff155a95ff96feba61258c0e6e5e1fca47557b9fd305e57a629753573b3123b352318df9a0ddb9b76367ec3d5991fdd6b8f6809c025dc68c7982087dcfa7940ebc564e32326d404be01d114c67494d72d017ce561bdaf1d74375bea6a4e9bfdfcf4db770732e1e727efc8fe083c2abff0ed719cf05bef3e8a4baeb843f3f1ae419f4c752fc2c7ea7ed4d6dd7f7a17dda15543dfed135d67db348921c8a5403d2e400f66bbadd26fdfab760bca362d273a839a80fb29495573169b6a5b32c1a4d8fe203d8b508c84f108ac7ac11d8c65b1e4e2380de4b629973d80487fc578ce27abd06c4112aeb13ad8c3dd2b43345c6ea5d684f9d41829a4f34ffc5789112adf3f933debd6a60c729cdd4a235743dc1cf7f84acb3898b329dcdae9896f7f5786ba22725b5d4b71cdbcca53743c09377a5d06df0b1555682904a6d5f1473a1099e703af292a9c1a9d6f83f1865515e58735b759c4c04c5336da2241a443ba1e7bb03f3f7dd79de1ec0c74ef581c0053abb2369d01e423a66c064ca1e8c60879762cc7df8983cd58e8c4c3403bd311a6e3eaf474c3310fb647c7b432d9b998cca3abab0f18f464fb39dc615be25d5277243f669b6c6dd7919fe32b3442e017c3713f24724c4e556ca56f6bd5d52c26cc7d398a7def7abba7914651dfad01bf6dcfb955d128a43af6aadcad74880cff6646b344b0c60314f633eeaff2d1b6ca1bbfbceb7cdf30c88dbe7adc45ca9bddd6070af5db535de96ec8f355e566cc134644706cbfbf44b542af4dd75bb79b5dde3d7a45ad99fee90555e5437133b27d25ed29be3a8db154b47aa9ad0601b99614c3c5b432fca60386d5395fbbd02b4ffe7abefdc24de7e6b8a1edc5867cb784adcf40fb37dab51bc1479f2a82c7d1c2773b34d76c9df78ceee3c0fb372ffe19623438c86d71724b90fa737bb08e3cefa3a2f381ca1eb7fceac15ab69df241cab627de5fdba79f0f8b62a57b0b10b5eb614fec28cab8d9489a9f0c8f47affa2fd5d9f0fcb8ff7278d2ada0f97a90827b65811dfece855ea9dab71beffaddcc61ee08fc5b94e846fdd34f1bf5456c14dfed41cdd87099c51de0e66a4c385e42afd6715ba4c3d1ee1944bcc7fe8df27c0eb808ddf0bb2d1046dea4fffd74b4c5fe2dfbfd1119fc4d8b97df1c356f3aecdd373533cb1df9c0fc5b77aa1b6dfe7011405738536a6d850a4ddaa232bffd16abdbfd1a2b75bc27f402d72ce74bb29cee1fc3db70d556f110ee2bc39d0922bc8eddf40d1179777f7f7963c6ee358d9bdd87ca8beedf64cc6ef47efda9a2b77536dd22ec6e27bebe69ea5ddedb5254de96fe23d9f7b6c221e87e8fc6f70dd86d956fdff5d326f8b6cea39387e979d3f89daad9f47765f08f50c7c7a04789bb550be33d3688a6b19dc550b1e7da47dc8bcd1affdae003cce137dbbf4db8b669befe2ca6b1b9bca6760f6a175ecceedc396d2d4439f9210e1fcc70bb206d437cf359f3d5ae466ac7169d61316371174cbb6e338a285d6c19b6dfacbb3b23dd990a6e94b39b0bbef9b4b9a0a3c50393c1aeb9f7f314cfd7fea474d091fba1f960e7e4dfa1f51f9f11bce4f74f09774cd8addd1f9914bc809f272bb40ffaf7a5056f913f2b2f6c5827bcbffca0c4d07e63616ba5fb67860d4bdc2eca47a58647bb9ec45ba747e1dbbb47bf3dfa3f1a99c5fc011bffc21bbf86cc199b02706170706c69636174696f6e2f6a736f6e03676465666c617465a40059094f789ced5ddf6fdb36107ecf5f11f4392fedd062e85b9b369881a601d2ae031604032d3189565932242a3f36ec7f1f45dbb228de519444c98e730186a511c5fb481ec9ef8ec7d3d5d1f1f1bff2bfe3e35751b22c44feeafdf195faf7e6efea59902e9669c213edb95e665d87e059c2e2ef4f4b2e4bbe626198f13c7f75a2174bd8423d0ef9324e9f78d67c2e1aafd79efe77e22e7dfe24382a7bc105c3e4ae5eac4bad7ebfdebe62c8cb455604e2f8d3ba559fa23c48ef79c6e6313f97d27ebc3e4d935599284de4ef37d16d0d41852c504ffeaa3fda0013c532e61b602b506b40523813fcbc106c1ec591782a4b2769b2644fa5f8755d553dc106489a95b5a94e755083f6e1ad1a91f18047f7dad062c35a0d693f4922fdc9134f620af987376fdf4162d8222d1201c9d9bc040ecbe6f50f72d0eff9273e17cdb1e059366c1494b6fef2061e85bc8841d09b97aca0cf6296df7de149c8b35316c77316fc3c6351cc43ef6db0747cd4bbcf67c93d8ba3f05b749b305164c62c1813f5224aa245b19895b5b93460987246ae62c07e3a37b1faeb23cbcccd95668dbf42a40f899b18b077bea6e22293382f6ab5789ebc10e82269ec50f0ee8462be6451b2da75a61cd2615dfd4dfe7f9c6eb640964b44c0bf7bdc442cb2e6e9dc5912d843eaedf3285f3011dc4db993f0c7250f040f7f933b82cb7ee2d04f16692c10058b5d65813df57bb2815cce825a55aeddd5acf04f9ea5973aab1952555d0fecf530c9e39e24fb28abba6171ce4f5c4636e48f729fd6dee8aaad03d7675704928c8a4c8ef8f1ecf3e3b2ac56b2e30d87ae56afa63236caf50439925dd35c056db034680ea2e7691a6372ef5812c67c7681da35e5bb8e72d1ae31cb8238b7a33a2b9fc801138de134e047db8250314b071a8d1902f29bb48ab81d695e16990823ac6b1a9ced7ce88349fbf7f5895dfdd636ee67c9ac8b9a656942c20a80a6acd1379e95d1a10f9b66a401d8e39096acfc571b989007d1422e9b363cab4a3ca1d1ed0a03cf3d9366e42c6c8353b3342a407db46b7671758d299632e966abadcfa65ab206522e100c29975db92e0ad155bbaadf75f7a02b035a235366266855351fc0fec0412ccce25d50e23132eee6fd0ac37ae3b67cf75e4ebbc3e0bb7da9243c4174eb74a59198420293a30ba16c01204dd65d8a57ed6f7ad1a66d7e67e97e5683d39833c94599e0a792d7df724863034b198733836a7ade48044a1e4d50b2f5ba6ff264eb91ad47b61e0c87e83802856c3dfd392917d97a1bc2dbcbd6238283ca2582430487080eed417bb90711c1c1e1907221509e2fc199a7f349e98db3837176312b1bb9433fe76ab0768a63e3efdc35883de80a35241fcba8dfa71fe0ac9eae377aa3f03397956bd812b00e3feee0803e74df73e763b8ab6b6d5dafdf0d10fcd116eaabdeb477b656c72176f7489630447c7c59c22d6b004c2ba65a089b571f5a65fb59763ef1659a47a2eda64ccf35675dfb1e4c8326c9dd8e3acf1a7630cc69b1eb0f9188e426f60f705fe370e6ba970887bc98ffcd83fe17355c21a0d1fe0362fd9120ff9738c23e2e268ca562c383689445f5f931e03ccccfd9e32513514ac3fe3286fd6b2acee4264c0bf90b19eff286c8873aed3ac411a7032b542e1d585990d281151d5841b01de1d0990202850eacf4e7a45c7460f5fe006e5f5cf2457acfe902464b39b3ac237e73c800066a6bcee6a7cf140718a9860561a51a9c263375c562ed4af81db00dee6c556b9a9db16a2d443a1c6ce850e03883d5d0632c760adcb80e6b10adccd619a7f1b76b40153b325d1da6ad10ca7815b60995dcb1cf31b2a2356624b5c0c88b06d04260348c2089f1811026341a469cd418100162a3400ed15a80e434e0612c5a8307701d058d94969476474a0bb3730d1fa6b57dac852627d7003579b98962a4f3f068e70152e908d15113f0e23cba9d8e1857f1303644663c8d01695b8f0fb60ea424d500e58d64852024233fa982d3678295b91179b88e08faf11ab7cdf37ac1e98df3efece7ca801d1e0c32969dee9c8371344741f39a7e372f41d5c5e423a0c0b0fd0e0cfb23127761c61ef6773118982d78d340a7a9e823713779e14d3c2fd90b4f473c381c522e04ca88473c236a9773fa51a331c8e70bb4c6f8f4f497acdf6ecee4699105b081211ab5f853bd560b2b172cb1fb0c701bab8f02564e63831f68c8b8bd98174fc28e3e41e1642a75fdc244c56d1ac9dcd2f574ae253aeef4318a9b22515fc41883d750e8d8b1f643a163143a46a163266c473844fd10286457e8cf49b99e875dd1995481ce9ef2a2b8039b9ace21493c86780cf118e231181cda6a1028c463f4e7a45c2f88c7ccd3f9b42c865233516aa65e280e3835133865dd1330ed951902c67b790e8cc0d75238b6cb7ee6e0cdb78fc5717972f0dbe2b6f459a295c4b5a396348af4e385e8875cbdba6bc7510d81be001de079100576b9caeea29c8e79bdfa9e4f867a62af5da863877846a8913d3e3a6c894583243845a1dd949f7f3fe31ce8c9690101e3b504bee7ee63a46ad12097a7bfbc7efbeeacec848f6996a50fb0d594adbf090caaabdfcf47abe5c8979cd6e84550905330b37d1fdc4e54261828c421eb99d2cd2f294b7a2967c3876dd5ccbacfba552d77b68cb8ab06d89d0bf67836a847479eeef7113782617df4a81953a56927aa9c6d84682137ef286071dc4f3d7154722865d5796760cf9581d149169d64d149169d646170e8b00181422759fa7352ae177492a5ae86f7f51f6466baa403726919b74435a00319558bece615599fa25b3c5a8b288916c562875f929626d69e20b8a8a78e1e8aa1eb923f7166122c1597d6e491329320a9b9347c96f45c1a44284557577cad5d8fbf0bb6af5bda2e55859b7d52157718a0f207ec041f8db1a7f2d25a644be735755bec734383dd9ae2ab1376f0efd7886a77b4874ce86d0551fba8c2bbc3c9d3618c6cd99554c10955cb966d4903dd927149c38d665df2891acfc0a4e1b66761326023999814701fb301c9cad4806c4b27a64146923329b83419bac2a6c9b0a793014f53a661b6cd06e36f005657bbd40009a52e33914de434b0a433d330619e837150d9529cf98235b12d82a63fd3da33629a44ecb2be86124f89a6c144afec0f058aa548d340dad2a46930c154690ae29009de9636cdc08aa54ed3b0facc9cd8489886fbe9d452349a87ae8291e3d13ea22ad3d763b7adc1f7d9b548058b15b5f2150dd1266cb5753949d3fa629f8211c68f84d9e3a829c5993eb29825c15e464ef90aa5a090cb671472e99a31afef0afcd04858e7f5c0e4e8fae87ffaef01b7011bffe5ffb4a3ff2cde02706170706c69636174696f6e2f6a736f6e03676465666c617465"
//     }}
// ).then(v => {
//     // console.log(Object.keys((v as any).cache));
//     // console.log(Object.keys((v as any).amCache));
//     RainDocument.create(`
//     /* ignore-next-line
//      */
// @ opmeta 0x78fd1edb0bdb928db6015990fecafbb964b44692e2d435693062dd4efc6254dd
// @ constss 0x56ffc3fc82109c33f1e1544157a70144fc15e7c6e9ae9c65a636fd165b1bc51c
// 'calling-context new-name /* renaming "calling-context" to "new-name" */
//   base ! /* eliding an item from this imported items */

// #xx 

// _: .int-add(
//     1 
//     .constss.new-name<1>()
// );
// `, v).then(v => {
//         console.log(v.namespace);
//         // Compile.RainDocument(v, ["xx"]).then(e => console.log(e)).catch(e => console.log(e));
//     }).catch(v => console.log(v));
// }).catch(v => console.log(v));