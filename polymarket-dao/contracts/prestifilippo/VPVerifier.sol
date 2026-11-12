// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";      // Utility OpenZeppelin per recuperare l'address firmatario partendo dalla firma e dal digest, via ECDSA.

/*
Libreria Solidity utile a verificare on-chain una VC firmata off-chain con EIP-712.
Prende i dati della credenziale, ricostruisce esattamente lo stesso hash digest che era stato firmato off-chain,
e poi usa la firma per recuperare la chiave pubblica di chi lo ha firmato.
Il contratto chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.
*/

library VPVerifier {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version)");
    bytes32 internal constant EIP712_NAME_HASH = keccak256(bytes("Universal VC Protocol"));
    bytes32 internal constant EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 internal constant UNIVERSAL_DOMAIN_SEPARATOR =
        keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH));

    /*
    Costruiamo i typeHash, ovvero gli hash delle strutture EIP-712 che compongono la VC.
    I nomi dei campi, l'ordine e l'annidamento DEVONO essere identici a quelli usati
    off-chain durante l'emissione e la firma della credenziale.
    Se anche un solo campo cambia ordine o nome, il digest ricostruito on-chain sarà diverso
    e la firma non verrà recuperata correttamente.
    */
    bytes32 internal constant ISSUER_TYPEHASH = keccak256("Issuer(string id)");

    /// TypeHash canonico del CredentialSubject firmato dallo script issue-for-dao.
    bytes32 internal constant CREDENTIAL_SUBJECT_TYPEHASH =
        keccak256(
            "CredentialSubject("
            "string id,"
            "string organization,"
            "string unit,"
            "string[] skills"
            ")"
        );

    /// TypeHash della struct principale VerifiableCredential.
    /// Include issuer, issuanceDate e credentialSubject in modo annidato, come richiede EIP-712.
    bytes32 internal constant VERIFIABLE_CREDENTIAL_TYPEHASH =
        keccak256(
            "VerifiableCredential("
            "Issuer issuer,"
            "string issuanceDate,"
            "CredentialSubject credentialSubject"
            ")"
            "CredentialSubject("
            "string id,"
            "string organization,"
            "string unit,"
            "string[] skills"
            ")"
            "Issuer("
            "string id"
            ")"
        );

    // Creazione struct per contenere i dati della VC.

    /// Identità dell'issuer, espressa come DID.
    struct Issuer {
        string id;
    }

    /// Struct contenente i dati certificati relativi all'holder.
    struct CredentialSubject {
        string id;
        string organization;
        string unit;
        string[] skills; // Array dinamico di skill
    }

    /// Struct contenente la VC completa: issuer, data di emissione e credentialSubject.
    struct VerifiableCredential {
        Issuer issuer;
        string issuanceDate;
        CredentialSubject credentialSubject;
    }

    /*
    Funzioni di hashing EIP-712.
    Le stringhe non vengono inserite direttamente nell'abi.encode della struct:
    vanno sempre pre-hashate con keccak256(bytes(...)), come previsto dallo standard.
    */

   /// Hash EIP-712 della struct Issuer. Hasha il typeHash e l'id dell'issuer.
    function hashIssuer(Issuer memory issuer) internal pure returns (bytes32) {
        return keccak256(abi.encode(ISSUER_TYPEHASH, keccak256(bytes(issuer.id))));
    }

    // Hash EIP-712 dell'array di stringhe: hash concatenato dei singoli elementi hashati.
    function hashSkills(string[] memory skills) internal pure returns (bytes32) {
        bytes32[] memory skillHashes = new bytes32[](skills.length);
        for (uint256 i = 0; i < skills.length; i++) {
            skillHashes[i] = keccak256(bytes(skills[i]));
        }
        return keccak256(abi.encodePacked(skillHashes));
    }

    /// Hash EIP-712 della struct CredentialSubject con tutti i campi certificati.
    function hashCredentialSubject(CredentialSubject memory cs) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CREDENTIAL_SUBJECT_TYPEHASH,
                keccak256(bytes(cs.id)),
                keccak256(bytes(cs.organization)),
                keccak256(bytes(cs.unit)),
                hashSkills(cs.skills)
            )
        );
    }

    /*
    Hash EIP-712 della credenziale completa.
    Per i campi struct annidati non si usa abi.encode diretto della struct,
    ma i rispettivi hash già calcolati: hashIssuer e hashCredentialSubject.
    */
    function hashVerifiableCredential(VerifiableCredential memory vc) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERIFIABLE_CREDENTIAL_TYPEHASH,
                hashIssuer(vc.issuer),
                keccak256(bytes(vc.issuanceDate)),
                hashCredentialSubject(vc.credentialSubject)
            )
        );
    }

    /*
        Recover Signer. Ricrea digest EIP-712 usando le funzioni precedentemente implementate. 
        Viene ricreato il digest EIP-712 concatenando il prefisso standard `0x1901`, il domainSeparator e il digest.
        Il digest finale deve combaciare bit-a-bit con quello usato dal firmatario off-chain.
        A partire dal digest e dalla firma, viene recuperato l'address relativo alla chiave pubblica che ha prodotto la firma.
        Il chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.
    */
    function recoverIssuer(
        VerifiableCredential memory vc,
        bytes memory signature
    ) internal pure returns (address signer) {
        bytes32 structHash = hashVerifiableCredential(vc);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", UNIVERSAL_DOMAIN_SEPARATOR, structHash)
        );
        signer = ECDSA.recover(digest, signature);
    }
}
