# **Rain Language - Standalone**
The Rain language (aka rainlang) standalone encapsulates the Rain language compiler (rlc) and Rain language services (in [LSP spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)) that are written in typescript, and exposes them through Language Server Protocol (lsp) standard definitions. This is well suited for editors and IDE support, which can be intracted with directly through API and be used in tools like Slate or be wrapped and managed in a client/server module and be used in monaco editor or codemirror.

The primary goal of the Rain language is to make smart contract development accessible for as many people as possible. This is fundamentally grounded in our belief that accessibility is the difference between theoretical and practical decentralisation. There are many people who would like to participate in authoring and auditing crypto code but currently cannot. When someone wants/needs to do something but cannot, then they delegate to someone who can, this is by definition centralisation.

For more info and details, please read this [article](https://hackmd.io/@REJeq0MuTUiqnjx9w5SsUA/HJj9s-nfi#Rainlang-has-a-spectrum-of-representations-from-concise-gtexplicit)

If you find an issue or you want to propose an improvement, please feel free to post it on: [issues](https://github.com/rouzwelt/rainlang/issues)


## **Tutorial**
To get started, install the package:
```bash
yarn add --dev https://github.com/rouzwelt/rainlang.git
or
npm install --save-dev https://github.com/rouzwelt/rainlang.git
```
<br>


### **Language Services**
Rain Language Services provide validation of a Rain docuemtn and services like completion, hover, etc.
```typescript
// importing
import { getLanguageService } from "@rainprotocol/rainlang";

// initiating the services
const langServices = getLanguageService(clientCapabilities);

// getting validation results (lsp Diagnostics)
const errors = await langServices.doValidate(myDocument, opmeta);
```
<br>

### **Rain Language Compiler (rlc) and Decompiler (rld)**
Rain Language compiler/decompiler, compiles a Rain document to a valid ExpressionConfig and vice versa for decompiler.
```typescript
// importing
import { rlc, rld } from "@rainprotocol/rainlang";

// compiling a Rain document to get ExpressionConfig aka deployable bytes
const bytes = await rlc(myDocument, opmeta);

// decompiling an ExpressionConfig to a valid Rain document
const rainDocument = await rld(expressionConfig, opmeta);
```

<br>

## **Developers**
To get started, clone the repo and install the dependencies:
```bash
git clone https://github.com/rouzwelt/rainlang.git
cd rainlang
yarn install
```


To build from source code:
```bash
yarn run build
```


To generate documents:
```bash
yar run docgen
```


To run tests:
```bash
yarn run test
```
