import { BigNumberish } from "../utils";


/**
 * @public Type for read-memory opcode
 */
export enum MemoryType {
    Stack,
    Constant,
}

/**
 * @public Type of position start and end indexes for RainDocument, inclusive at both ends
 */
export type RDPosition = [number, number];

/**
 * @public Type of RainDocument's problem (error)
 */
export type RDProblem = {
    msg: string;
    position: RDPosition;
    code: number;
};

/**
 * @public Type of RainDocument's Value node
 */
export type RDValueNode = {
    value: BigNumberish;
    position: RDPosition;
    lhs?: RDAliasNode;
};

/**
 * @public Type of RainDocument's Opcode node
 */
export type RDOpNode = {
    opcode: {
        name: string;
        description: string;
        position: RDPosition;
    };
    operand: number;
    output: number;
    position: RDPosition;
    parens: RDPosition;
    parameters: RDNode[];
    operandArgs?: {
        position: RDPosition;
        args: {
            value: number;
            name: string;
            position: RDPosition;
            description?: string;
        }[];
    };
    lhs?: RDAliasNode[];
};

/**
 * @public Type of RainDocument's lhs aliases
 */
export type RDAliasNode = {
    name: string;
    position: RDPosition;
    lhs?: RDAliasNode;
}

/**
 * @public Type of RainDocument's comments
 */
export type RDComment = {
    comment: string;
    position: RDPosition;
}

/**
 * @public Type of meta hash specified in a Rain Document
 */
export type RDMetaHash = {
    hash: string;
    position: RDPosition;
}

/**
 * @public Type of RainDocument's prase node
 */
export type RDNode = RDValueNode | RDOpNode | RDAliasNode;

/**
* @public Type of a RainDocument parse tree object
*/
export type RDParseTree = { tree: RDNode[]; position: RDPosition; }[];

/**
 * @public Type of Parser's State
 */
export type RainParseState = {
    parse: {
        tree: RDNode[];
        aliases: RDAliasNode[];
    };
    track: {
        char: number;
        parens: {
            open: number[];
            close: number[];
        };
    };
    depthLevel: number;
    operandArgsErr: boolean;
    runtimeError: Error | undefined;
};
