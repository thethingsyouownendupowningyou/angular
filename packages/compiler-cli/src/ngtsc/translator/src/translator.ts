/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ArrayType, AssertNotNull, BinaryOperator, BinaryOperatorExpr, BuiltinType, BuiltinTypeName, CastExpr, ClassStmt, CommaExpr, CommentStmt, ConditionalExpr, DeclareFunctionStmt, DeclareVarStmt, Expression, ExpressionStatement, ExpressionType, ExpressionVisitor, ExternalExpr, ExternalReference, FunctionExpr, IfStmt, InstantiateExpr, InvokeFunctionExpr, InvokeMethodExpr, JSDocCommentStmt, LiteralArrayExpr, LiteralExpr, LiteralMapExpr, MapType, NotExpr, ReadKeyExpr, ReadPropExpr, ReadVarExpr, ReturnStatement, Statement, StatementVisitor, StmtModifier, ThrowStmt, TryCatchStmt, Type, TypeVisitor, TypeofExpr, WrappedNodeExpr, WriteKeyExpr, WritePropExpr, WriteVarExpr} from '@angular/compiler';
import {LocalizedString} from '@angular/compiler/src/output/output_ast';
import * as ts from 'typescript';

import {DefaultImportRecorder, ImportRewriter, NOOP_DEFAULT_IMPORT_RECORDER, NoopImportRewriter} from '../../imports';

export class Context {
  constructor(readonly isStatement: boolean) {}

  get withExpressionMode(): Context { return this.isStatement ? new Context(false) : this; }

  get withStatementMode(): Context { return !this.isStatement ? new Context(true) : this; }
}

const BINARY_OPERATORS = new Map<BinaryOperator, ts.BinaryOperator>([
  [BinaryOperator.And, ts.SyntaxKind.AmpersandAmpersandToken],
  [BinaryOperator.Bigger, ts.SyntaxKind.GreaterThanToken],
  [BinaryOperator.BiggerEquals, ts.SyntaxKind.GreaterThanEqualsToken],
  [BinaryOperator.BitwiseAnd, ts.SyntaxKind.AmpersandToken],
  [BinaryOperator.Divide, ts.SyntaxKind.SlashToken],
  [BinaryOperator.Equals, ts.SyntaxKind.EqualsEqualsToken],
  [BinaryOperator.Identical, ts.SyntaxKind.EqualsEqualsEqualsToken],
  [BinaryOperator.Lower, ts.SyntaxKind.LessThanToken],
  [BinaryOperator.LowerEquals, ts.SyntaxKind.LessThanEqualsToken],
  [BinaryOperator.Minus, ts.SyntaxKind.MinusToken],
  [BinaryOperator.Modulo, ts.SyntaxKind.PercentToken],
  [BinaryOperator.Multiply, ts.SyntaxKind.AsteriskToken],
  [BinaryOperator.NotEquals, ts.SyntaxKind.ExclamationEqualsToken],
  [BinaryOperator.NotIdentical, ts.SyntaxKind.ExclamationEqualsEqualsToken],
  [BinaryOperator.Or, ts.SyntaxKind.BarBarToken],
  [BinaryOperator.Plus, ts.SyntaxKind.PlusToken],
]);

/**
 * Information about an import that has been added to a module.
 */
export interface Import {
  /** The name of the module that has been imported. */
  specifier: string;
  /** The alias of the imported module. */
  qualifier: string;
}

/**
 * The symbol name and import namespace of an imported symbol,
 * which has been registered through the ImportManager.
 */
export interface NamedImport {
  /** The import namespace containing this imported symbol. */
  moduleImport: string|null;
  /** The (possibly rewritten) name of the imported symbol. */
  symbol: string;
}

export class ImportManager {
  private specifierToIdentifier = new Map<string, string>();
  private nextIndex = 0;

  constructor(protected rewriter: ImportRewriter = new NoopImportRewriter(), private prefix = 'i') {
  }

  generateNamedImport(moduleName: string, originalSymbol: string): NamedImport {
    // First, rewrite the symbol name.
    const symbol = this.rewriter.rewriteSymbol(originalSymbol, moduleName);

    // Ask the rewriter if this symbol should be imported at all. If not, it can be referenced
    // directly (moduleImport: null).
    if (!this.rewriter.shouldImportSymbol(symbol, moduleName)) {
      // The symbol should be referenced directly.
      return {moduleImport: null, symbol};
    }

    // If not, this symbol will be imported. Allocate a prefix for the imported module if needed.

    if (!this.specifierToIdentifier.has(moduleName)) {
      this.specifierToIdentifier.set(moduleName, `${this.prefix}${this.nextIndex++}`);
    }
    const moduleImport = this.specifierToIdentifier.get(moduleName) !;

    return {moduleImport, symbol};
  }

  getAllImports(contextPath: string): Import[] {
    const imports: {specifier: string, qualifier: string}[] = [];
    this.specifierToIdentifier.forEach((qualifier, specifier) => {
      specifier = this.rewriter.rewriteSpecifier(specifier, contextPath);
      imports.push({specifier, qualifier});
    });
    return imports;
  }
}

export function translateExpression(
    expression: Expression, imports: ImportManager, defaultImportRecorder: DefaultImportRecorder,
    scriptTarget: Exclude<ts.ScriptTarget, ts.ScriptTarget.JSON>): ts.Expression {
  return expression.visitExpression(
      new ExpressionTranslatorVisitor(imports, defaultImportRecorder, scriptTarget),
      new Context(false));
}

export function translateStatement(
    statement: Statement, imports: ImportManager, defaultImportRecorder: DefaultImportRecorder,
    scriptTarget: Exclude<ts.ScriptTarget, ts.ScriptTarget.JSON>): ts.Statement {
  return statement.visitStatement(
      new ExpressionTranslatorVisitor(imports, defaultImportRecorder, scriptTarget),
      new Context(true));
}

export function translateType(type: Type, imports: ImportManager): ts.TypeNode {
  return type.visitType(new TypeTranslatorVisitor(imports), new Context(false));
}

class ExpressionTranslatorVisitor implements ExpressionVisitor, StatementVisitor {
  private externalSourceFiles = new Map<string, ts.SourceMapSource>();
  constructor(
      private imports: ImportManager, private defaultImportRecorder: DefaultImportRecorder,
      private scriptTarget: Exclude<ts.ScriptTarget, ts.ScriptTarget.JSON>) {}

  visitDeclareVarStmt(stmt: DeclareVarStmt, context: Context): ts.VariableStatement {
    const nodeFlags =
        ((this.scriptTarget >= ts.ScriptTarget.ES2015) && stmt.hasModifier(StmtModifier.Final)) ?
        ts.NodeFlags.Const :
        ts.NodeFlags.None;
    return ts.createVariableStatement(
        undefined, ts.createVariableDeclarationList(
                       [ts.createVariableDeclaration(
                           stmt.name, undefined, stmt.value &&
                               stmt.value.visitExpression(this, context.withExpressionMode))],
                       nodeFlags));
  }

  visitDeclareFunctionStmt(stmt: DeclareFunctionStmt, context: Context): ts.FunctionDeclaration {
    return ts.createFunctionDeclaration(
        undefined, undefined, undefined, stmt.name, undefined,
        stmt.params.map(param => ts.createParameter(undefined, undefined, undefined, param.name)),
        undefined, ts.createBlock(stmt.statements.map(
                       child => child.visitStatement(this, context.withStatementMode))));
  }

  visitExpressionStmt(stmt: ExpressionStatement, context: Context): ts.ExpressionStatement {
    return ts.createStatement(stmt.expr.visitExpression(this, context.withStatementMode));
  }

  visitReturnStmt(stmt: ReturnStatement, context: Context): ts.ReturnStatement {
    return ts.createReturn(stmt.value.visitExpression(this, context.withExpressionMode));
  }

  visitDeclareClassStmt(stmt: ClassStmt, context: Context) {
    if (this.scriptTarget < ts.ScriptTarget.ES2015) {
      throw new Error(
          `Unsupported mode: Visiting a "declare class" statement (class ${stmt.name}) while ` +
          `targeting ${ts.ScriptTarget[this.scriptTarget]}.`);
    }
    throw new Error('Method not implemented.');
  }

  visitIfStmt(stmt: IfStmt, context: Context): ts.IfStatement {
    return ts.createIf(
        stmt.condition.visitExpression(this, context),
        ts.createBlock(
            stmt.trueCase.map(child => child.visitStatement(this, context.withStatementMode))),
        stmt.falseCase.length > 0 ?
            ts.createBlock(stmt.falseCase.map(
                child => child.visitStatement(this, context.withStatementMode))) :
            undefined);
  }

  visitTryCatchStmt(stmt: TryCatchStmt, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitThrowStmt(stmt: ThrowStmt, context: Context): ts.ThrowStatement {
    return ts.createThrow(stmt.error.visitExpression(this, context.withExpressionMode));
  }

  visitCommentStmt(stmt: CommentStmt, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitJSDocCommentStmt(stmt: JSDocCommentStmt, context: Context): ts.NotEmittedStatement {
    const commentStmt = ts.createNotEmittedStatement(ts.createLiteral(''));
    const text = stmt.toString();
    const kind = ts.SyntaxKind.MultiLineCommentTrivia;
    ts.setSyntheticLeadingComments(commentStmt, [{kind, text, pos: -1, end: -1}]);
    return commentStmt;
  }

  visitReadVarExpr(ast: ReadVarExpr, context: Context): ts.Identifier {
    const identifier = ts.createIdentifier(ast.name !);
    this.setSourceMapRange(identifier, ast);
    return identifier;
  }

  visitWriteVarExpr(expr: WriteVarExpr, context: Context): ts.Expression {
    const result: ts.Expression = ts.createBinary(
        ts.createIdentifier(expr.name), ts.SyntaxKind.EqualsToken,
        expr.value.visitExpression(this, context));
    return context.isStatement ? result : ts.createParen(result);
  }

  visitWriteKeyExpr(expr: WriteKeyExpr, context: Context): ts.Expression {
    const exprContext = context.withExpressionMode;
    const lhs = ts.createElementAccess(
        expr.receiver.visitExpression(this, exprContext),
        expr.index.visitExpression(this, exprContext));
    const rhs = expr.value.visitExpression(this, exprContext);
    const result: ts.Expression = ts.createBinary(lhs, ts.SyntaxKind.EqualsToken, rhs);
    return context.isStatement ? result : ts.createParen(result);
  }

  visitWritePropExpr(expr: WritePropExpr, context: Context): ts.BinaryExpression {
    return ts.createBinary(
        ts.createPropertyAccess(expr.receiver.visitExpression(this, context), expr.name),
        ts.SyntaxKind.EqualsToken, expr.value.visitExpression(this, context));
  }

  visitInvokeMethodExpr(ast: InvokeMethodExpr, context: Context): ts.CallExpression {
    const target = ast.receiver.visitExpression(this, context);
    const call = ts.createCall(
        ast.name !== null ? ts.createPropertyAccess(target, ast.name) : target, undefined,
        ast.args.map(arg => arg.visitExpression(this, context)));
    this.setSourceMapRange(call, ast);
    return call;
  }

  visitInvokeFunctionExpr(ast: InvokeFunctionExpr, context: Context): ts.CallExpression {
    const expr = ts.createCall(
        ast.fn.visitExpression(this, context), undefined,
        ast.args.map(arg => arg.visitExpression(this, context)));
    if (ast.pure) {
      ts.addSyntheticLeadingComment(expr, ts.SyntaxKind.MultiLineCommentTrivia, '@__PURE__', false);
    }
    this.setSourceMapRange(expr, ast);
    return expr;
  }

  visitInstantiateExpr(ast: InstantiateExpr, context: Context): ts.NewExpression {
    return ts.createNew(
        ast.classExpr.visitExpression(this, context), undefined,
        ast.args.map(arg => arg.visitExpression(this, context)));
  }

  visitLiteralExpr(ast: LiteralExpr, context: Context): ts.Expression {
    let expr: ts.Expression;
    if (ast.value === undefined) {
      expr = ts.createIdentifier('undefined');
    } else if (ast.value === null) {
      expr = ts.createNull();
    } else {
      expr = ts.createLiteral(ast.value);
    }
    this.setSourceMapRange(expr, ast);
    return expr;
  }

  visitLocalizedString(ast: LocalizedString, context: Context): ts.Expression {
    if (this.scriptTarget < ts.ScriptTarget.ES2015) {
      // This should never happen.
      throw new Error(
          'Unsupported mode: Visiting a localized string (which produces a tagged template ' +
          `literal) ' while targeting ${ts.ScriptTarget[this.scriptTarget]}.`);
    }
    return visitLocalizedString(ast, context, this);
  }

  visitExternalExpr(ast: ExternalExpr, context: Context): ts.PropertyAccessExpression
      |ts.Identifier {
    if (ast.value.name === null) {
      throw new Error(`Import unknown module or symbol ${ast.value}`);
    }
    // If a moduleName is specified, this is a normal import. If there's no module name, it's a
    // reference to a global/ambient symbol.
    if (ast.value.moduleName !== null) {
      // This is a normal import. Find the imported module.
      const {moduleImport, symbol} =
          this.imports.generateNamedImport(ast.value.moduleName, ast.value.name);
      if (moduleImport === null) {
        // The symbol was ambient after all.
        return ts.createIdentifier(symbol);
      } else {
        return ts.createPropertyAccess(
            ts.createIdentifier(moduleImport), ts.createIdentifier(symbol));
      }
    } else {
      // The symbol is ambient, so just reference it.
      return ts.createIdentifier(ast.value.name);
    }
  }

  visitConditionalExpr(ast: ConditionalExpr, context: Context): ts.ConditionalExpression {
    return ts.createConditional(
        ast.condition.visitExpression(this, context), ast.trueCase.visitExpression(this, context),
        ast.falseCase !.visitExpression(this, context));
  }

  visitNotExpr(ast: NotExpr, context: Context): ts.PrefixUnaryExpression {
    return ts.createPrefix(
        ts.SyntaxKind.ExclamationToken, ast.condition.visitExpression(this, context));
  }

  visitAssertNotNullExpr(ast: AssertNotNull, context: Context): ts.NonNullExpression {
    return ast.condition.visitExpression(this, context);
  }

  visitCastExpr(ast: CastExpr, context: Context): ts.Expression {
    return ast.value.visitExpression(this, context);
  }

  visitFunctionExpr(ast: FunctionExpr, context: Context): ts.FunctionExpression {
    return ts.createFunctionExpression(
        undefined, undefined, ast.name || undefined, undefined,
        ast.params.map(
            param => ts.createParameter(
                undefined, undefined, undefined, param.name, undefined, undefined, undefined)),
        undefined, ts.createBlock(ast.statements.map(stmt => stmt.visitStatement(this, context))));
  }

  visitBinaryOperatorExpr(ast: BinaryOperatorExpr, context: Context): ts.Expression {
    if (!BINARY_OPERATORS.has(ast.operator)) {
      throw new Error(`Unknown binary operator: ${BinaryOperator[ast.operator]}`);
    }
    return ts.createBinary(
        ast.lhs.visitExpression(this, context), BINARY_OPERATORS.get(ast.operator) !,
        ast.rhs.visitExpression(this, context));
  }

  visitReadPropExpr(ast: ReadPropExpr, context: Context): ts.PropertyAccessExpression {
    return ts.createPropertyAccess(ast.receiver.visitExpression(this, context), ast.name);
  }

  visitReadKeyExpr(ast: ReadKeyExpr, context: Context): ts.ElementAccessExpression {
    return ts.createElementAccess(
        ast.receiver.visitExpression(this, context), ast.index.visitExpression(this, context));
  }

  visitLiteralArrayExpr(ast: LiteralArrayExpr, context: Context): ts.ArrayLiteralExpression {
    const expr =
        ts.createArrayLiteral(ast.entries.map(expr => expr.visitExpression(this, context)));
    this.setSourceMapRange(expr, ast);
    return expr;
  }

  visitLiteralMapExpr(ast: LiteralMapExpr, context: Context): ts.ObjectLiteralExpression {
    const entries = ast.entries.map(
        entry => ts.createPropertyAssignment(
            entry.quoted ? ts.createLiteral(entry.key) : ts.createIdentifier(entry.key),
            entry.value.visitExpression(this, context)));
    const expr = ts.createObjectLiteral(entries);
    this.setSourceMapRange(expr, ast);
    return expr;
  }

  visitCommaExpr(ast: CommaExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitWrappedNodeExpr(ast: WrappedNodeExpr<any>, context: Context): any {
    if (ts.isIdentifier(ast.node)) {
      this.defaultImportRecorder.recordUsedIdentifier(ast.node);
    }
    return ast.node;
  }

  visitTypeofExpr(ast: TypeofExpr, context: Context): ts.TypeOfExpression {
    return ts.createTypeOf(ast.expr.visitExpression(this, context));
  }

  private setSourceMapRange(expr: ts.Expression, ast: Expression) {
    if (ast.sourceSpan) {
      const {start, end} = ast.sourceSpan;
      const {url, content} = start.file;
      if (url) {
        if (!this.externalSourceFiles.has(url)) {
          this.externalSourceFiles.set(url, ts.createSourceMapSource(url, content, pos => pos));
        }
        const source = this.externalSourceFiles.get(url);
        ts.setSourceMapRange(expr, {pos: start.offset, end: end.offset, source});
      }
    }
  }
}

export class TypeTranslatorVisitor implements ExpressionVisitor, TypeVisitor {
  constructor(private imports: ImportManager) {}

  visitBuiltinType(type: BuiltinType, context: Context): ts.KeywordTypeNode {
    switch (type.name) {
      case BuiltinTypeName.Bool:
        return ts.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
      case BuiltinTypeName.Dynamic:
        return ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
      case BuiltinTypeName.Int:
      case BuiltinTypeName.Number:
        return ts.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      case BuiltinTypeName.String:
        return ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      case BuiltinTypeName.None:
        return ts.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
      default:
        throw new Error(`Unsupported builtin type: ${BuiltinTypeName[type.name]}`);
    }
  }

  visitExpressionType(type: ExpressionType, context: Context): ts.TypeReferenceType {
    const expr: ts.Identifier|ts.QualifiedName = type.value.visitExpression(this, context);
    const typeArgs = type.typeParams !== null ?
        type.typeParams.map(param => param.visitType(this, context)) :
        undefined;

    return ts.createTypeReferenceNode(expr, typeArgs);
  }

  visitArrayType(type: ArrayType, context: Context): ts.ArrayTypeNode {
    return ts.createArrayTypeNode(type.visitType(this, context));
  }

  visitMapType(type: MapType, context: Context): ts.TypeLiteralNode {
    const parameter = ts.createParameter(
        undefined, undefined, undefined, 'key', undefined,
        ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword));
    const typeArgs = type.valueType !== null ? type.valueType.visitType(this, context) : undefined;
    const indexSignature = ts.createIndexSignature(undefined, undefined, [parameter], typeArgs);
    return ts.createTypeLiteralNode([indexSignature]);
  }

  visitReadVarExpr(ast: ReadVarExpr, context: Context): string {
    if (ast.name === null) {
      throw new Error(`ReadVarExpr with no variable name in type`);
    }
    return ast.name;
  }

  visitWriteVarExpr(expr: WriteVarExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitWriteKeyExpr(expr: WriteKeyExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitWritePropExpr(expr: WritePropExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitInvokeMethodExpr(ast: InvokeMethodExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitInvokeFunctionExpr(ast: InvokeFunctionExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitInstantiateExpr(ast: InstantiateExpr, context: Context): never {
    throw new Error('Method not implemented.');
  }

  visitLiteralExpr(ast: LiteralExpr, context: Context): ts.LiteralExpression {
    return ts.createLiteral(ast.value as string);
  }

  visitLocalizedString(ast: LocalizedString, context: Context): ts.Expression {
    return visitLocalizedString(ast, context, this);
  }

  visitExternalExpr(ast: ExternalExpr, context: Context): ts.TypeNode {
    if (ast.value.moduleName === null || ast.value.name === null) {
      throw new Error(`Import unknown module or symbol`);
    }
    const {moduleImport, symbol} =
        this.imports.generateNamedImport(ast.value.moduleName, ast.value.name);
    const symbolIdentifier = ts.createIdentifier(symbol);

    const typeName = moduleImport ?
        ts.createPropertyAccess(ts.createIdentifier(moduleImport), symbolIdentifier) :
        symbolIdentifier;

    const typeArguments =
        ast.typeParams ? ast.typeParams.map(type => type.visitType(this, context)) : undefined;

    return ts.createExpressionWithTypeArguments(typeArguments, typeName);
  }

  visitConditionalExpr(ast: ConditionalExpr, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitNotExpr(ast: NotExpr, context: Context) { throw new Error('Method not implemented.'); }

  visitAssertNotNullExpr(ast: AssertNotNull, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitCastExpr(ast: CastExpr, context: Context) { throw new Error('Method not implemented.'); }

  visitFunctionExpr(ast: FunctionExpr, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitBinaryOperatorExpr(ast: BinaryOperatorExpr, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitReadPropExpr(ast: ReadPropExpr, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitReadKeyExpr(ast: ReadKeyExpr, context: Context) {
    throw new Error('Method not implemented.');
  }

  visitLiteralArrayExpr(ast: LiteralArrayExpr, context: Context): ts.TupleTypeNode {
    const values = ast.entries.map(expr => expr.visitExpression(this, context));
    return ts.createTupleTypeNode(values);
  }

  visitLiteralMapExpr(ast: LiteralMapExpr, context: Context): ts.ObjectLiteralExpression {
    const entries = ast.entries.map(entry => {
      const {key, quoted} = entry;
      const value = entry.value.visitExpression(this, context);
      return ts.createPropertyAssignment(quoted ? `'${key}'` : key, value);
    });
    return ts.createObjectLiteral(entries);
  }

  visitCommaExpr(ast: CommaExpr, context: Context) { throw new Error('Method not implemented.'); }

  visitWrappedNodeExpr(ast: WrappedNodeExpr<any>, context: Context): ts.Identifier {
    const node: ts.Node = ast.node;
    if (ts.isIdentifier(node)) {
      return node;
    } else {
      throw new Error(
          `Unsupported WrappedNodeExpr in TypeTranslatorVisitor: ${ts.SyntaxKind[node.kind]}`);
    }
  }

  visitTypeofExpr(ast: TypeofExpr, context: Context): ts.TypeQueryNode {
    let expr = translateExpression(
        ast.expr, this.imports, NOOP_DEFAULT_IMPORT_RECORDER, ts.ScriptTarget.ES2015);
    return ts.createTypeQueryNode(expr as ts.Identifier);
  }
}

/**
 * A helper to reduce duplication, since this functionality is required in both
 * `ExpressionTranslatorVisitor` and `TypeTranslatorVisitor`.
 */
function visitLocalizedString(ast: LocalizedString, context: Context, visitor: ExpressionVisitor) {
  let template: ts.TemplateLiteral;
  const metaBlock = ast.serializeI18nHead();
  if (ast.messageParts.length === 1) {
    template = ts.createNoSubstitutionTemplateLiteral(metaBlock.cooked, metaBlock.raw);
  } else {
    const head = ts.createTemplateHead(metaBlock.cooked, metaBlock.raw);
    const spans: ts.TemplateSpan[] = [];
    for (let i = 1; i < ast.messageParts.length; i++) {
      const resolvedExpression = ast.expressions[i - 1].visitExpression(visitor, context);
      const templatePart = ast.serializeI18nTemplatePart(i);
      const templateMiddle = ts.createTemplateMiddle(templatePart.cooked, templatePart.raw);
      spans.push(ts.createTemplateSpan(resolvedExpression, templateMiddle));
    }
    if (spans.length > 0) {
      // The last span is supposed to have a tail rather than a middle
      spans[spans.length - 1].literal.kind = ts.SyntaxKind.TemplateTail;
    }
    template = ts.createTemplateExpression(head, spans);
  }
  return ts.createTaggedTemplate(ts.createIdentifier('$localize'), template);
}
